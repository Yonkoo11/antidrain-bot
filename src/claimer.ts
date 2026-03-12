import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { config } from "./config";
import { logger } from "./logger";

let primaryConnection: Connection;
let fallbackConnection: Connection | null = null;

export function setClaimerConnections(
  primary: Connection,
  fallback: Connection | null
): void {
  primaryConnection = primary;
  fallbackConnection = fallback;
}

export interface ClaimJob {
  /** Program ID to call */
  programId: string;
  /** Hex-encoded instruction data */
  data: string;
  /** Additional account metas: [pubkey, isSigner, isWritable] */
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  /** Optional label for logging */
  label?: string;
}

/**
 * Execute a claim transaction with sponsor-paid gas.
 * The compromised wallet signs as the caller, sponsor pays fees.
 */
export async function executeClaim(
  connection: Connection,
  job: ClaimJob
): Promise<string> {
  const { compromisedWallet, sponsorWallet, priorityFee } = config;

  const programId = new PublicKey(job.programId);
  const data = Buffer.from(job.data, "hex");

  // Build account keys
  const keys = job.accounts.map((acc) => ({
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  }));

  const tx = new Transaction();

  // Priority fee
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee,
    })
  );
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    })
  );

  // The claim instruction
  tx.add(
    new TransactionInstruction({
      programId,
      keys,
      data,
    })
  );

  // Sponsor pays gas
  tx.feePayer = sponsorWallet.publicKey;

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  // Sign with both wallets
  tx.sign(sponsorWallet, compromisedWallet);

  const serializedTx = tx.serialize() as Buffer;

  // Send through all RPCs
  const connections = [primaryConnection || connection];
  if (fallbackConnection) connections.push(fallbackConnection);

  const results = await Promise.allSettled(
    connections.map(async (conn, i) => {
      const label = i === 0 ? "primary" : "fallback";
      const sig = await conn.sendRawTransaction(serializedTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 2,
      });
      logger.info(`Claim TX sent via ${label}: ${sig}`);
      return { sig, conn };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { sig, conn } = result.value;
      await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      return sig;
    }
  }

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  throw errors[0] || new Error("All RPCs failed to send claim transaction");
}

/**
 * Watch a claims file for new claim jobs.
 * Write JSON claim jobs to claims.json - the bot picks them up automatically.
 */
export function watchClaimsFile(connection: Connection): void {
  const fs = require("fs");
  const path = require("path");
  const claimsPath = path.join(process.cwd(), "claims.json");

  // Create empty claims file if it doesn't exist
  if (!fs.existsSync(claimsPath)) {
    fs.writeFileSync(claimsPath, "[]");
  }

  // Poll the file every 3 seconds
  setInterval(async () => {
    try {
      const content = fs.readFileSync(claimsPath, "utf-8").trim();
      if (!content || content === "[]") return;

      const jobs: ClaimJob[] = JSON.parse(content);
      if (jobs.length === 0) return;

      logger.info(`Found ${jobs.length} claim job(s)`);

      for (const job of jobs) {
        const label = job.label || job.programId;
        try {
          logger.info(`Executing claim: ${label}`);
          const sig = await executeClaim(connection, job);
          logger.info(`Claim SUCCESS: ${label} -> TX: ${sig}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`Claim FAILED: ${label} -> ${msg}`);
        }
      }

      // Clear the file after processing
      fs.writeFileSync(claimsPath, "[]");
    } catch {
      // File read/parse error - ignore
    }
  }, 3000);

  logger.info("[CLAIM] Watching claims.json for airdrop claim jobs");
}
