import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SendTransactionError,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
import { config } from "./config";
import { logger } from "./logger";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Track in-flight sweeps to avoid duplicates
const pendingSweeps = new Set<string>();

// Track frozen/untransferable tokens so we don't waste gas retrying
const frozenMints = new Set<string>();

// Primary and fallback connections
let primaryConnection: Connection;
let fallbackConnection: Connection | null = null;

export function setConnections(
  primary: Connection,
  fallback: Connection | null
): void {
  primaryConnection = primary;
  fallbackConnection = fallback;
}

// Send tx through all available RPCs simultaneously - first one to land wins
async function sendTxToAll(
  serializedTx: Buffer,
  blockhash: string,
  lastValidBlockHeight: number
): Promise<string> {
  const sendOpts = {
    skipPreflight: false,
    preflightCommitment: "confirmed" as const,
    maxRetries: 2,
  };

  const connections = [primaryConnection];
  if (fallbackConnection) connections.push(fallbackConnection);

  // Fire tx to all RPCs at once
  const results = await Promise.allSettled(
    connections.map(async (conn, i) => {
      const label = i === 0 ? "primary" : "fallback";
      try {
        const sig = await conn.sendRawTransaction(serializedTx, sendOpts);
        logger.info(`TX sent via ${label}: ${sig}`);
        return { sig, conn };
      } catch (err) {
        logger.warn(
          `TX send failed via ${label}: ${err instanceof Error ? err.message : err}`
        );
        throw err;
      }
    })
  );

  // Find the first successful send
  for (const result of results) {
    if (result.status === "fulfilled") {
      const { sig, conn } = result.value;
      // Confirm on the connection that accepted it
      await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      return sig;
    }
  }

  // All failed
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  throw errors[0] || new Error("All RPCs failed to send transaction");
}

export async function sweepToken(
  connection: Connection,
  mint: PublicKey,
  sourceTokenAccount: PublicKey,
  amount: bigint
): Promise<string | null> {
  const mintStr = mint.toBase58();

  if (frozenMints.has(mintStr)) return null;
  if (pendingSweeps.has(mintStr)) return null;

  pendingSweeps.add(mintStr);

  try {
    return await sweepWithRetry(connection, mint, sourceTokenAccount, amount);
  } finally {
    pendingSweeps.delete(mintStr);
  }
}

async function sweepWithRetry(
  connection: Connection,
  mint: PublicKey,
  sourceTokenAccount: PublicKey,
  amount: bigint
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const sig = await executeSweep(
        connection,
        mint,
        sourceTokenAccount,
        amount
      );
      logger.info(
        `Sweep SUCCESS: ${amount} of ${mint.toBase58()} -> ${config.safeWallet.toBase58()}`
      );
      logger.info(`TX: ${sig}`);
      return sig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Detect frozen/untransferable accounts - don't retry
      if (msg.includes("Account is frozen") || msg.includes("0x11")) {
        logger.warn(
          `Token ${mint.toBase58()} is FROZEN (likely scam). Skipping permanently.`
        );
        frozenMints.add(mint.toBase58());
        return null;
      }

      logger.warn(
        `Sweep attempt ${attempt}/${MAX_RETRIES} failed for ${mint.toBase58()}: ${msg}`
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  logger.error(
    `Sweep FAILED after ${MAX_RETRIES} attempts for ${mint.toBase58()}`
  );
  return null;
}

async function executeSweep(
  connection: Connection,
  mint: PublicKey,
  sourceTokenAccount: PublicKey,
  amount: bigint
): Promise<string> {
  const { compromisedWallet, sponsorWallet, safeWallet, priorityFee } = config;

  const destAta = await getAssociatedTokenAddress(mint, safeWallet);

  const tx = new Transaction();

  // Priority fee to front-run drainer
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee,
    })
  );
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 200_000,
    })
  );

  // Create dest ATA if needed
  const destAccountInfo = await connection.getAccountInfo(destAta);
  if (!destAccountInfo) {
    logger.info(`Creating ATA for ${mint.toBase58()} on safe wallet`);
    tx.add(
      createAssociatedTokenAccountInstruction(
        sponsorWallet.publicKey,
        destAta,
        safeWallet,
        mint
      )
    );
  }

  // Transfer all tokens
  tx.add(
    createTransferInstruction(
      sourceTokenAccount,
      destAta,
      compromisedWallet.publicKey,
      amount
    )
  );

  tx.feePayer = sponsorWallet.publicKey;

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  tx.sign(sponsorWallet, compromisedWallet);

  const serializedTx = tx.serialize() as Buffer;

  // Send through all RPCs simultaneously for fastest landing
  const sig = await sendTxToAll(serializedTx, blockhash, lastValidBlockHeight);
  return sig;
}

export async function sweepAllTokens(
  connection: Connection
): Promise<{ swept: number; failed: number; skipped: number }> {
  const compromisedPubkey = config.compromisedWallet.publicKey;

  // Only log scans at debug level to reduce noise
  logger.debug(
    `Scanning token accounts for ${compromisedPubkey.toBase58()}...`
  );

  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    compromisedPubkey,
    { programId: TOKEN_PROGRAM_ID }
  );

  let swept = 0;
  let failed = 0;
  let skipped = 0;

  for (const { pubkey, account } of tokenAccounts.value) {
    const parsed = account.data.parsed;
    const info = parsed.info;
    const amount = BigInt(info.tokenAmount.amount);

    if (amount === 0n) continue;

    const mint = new PublicKey(info.mint);
    const mintStr = mint.toBase58();

    if (frozenMints.has(mintStr)) {
      skipped++;
      continue;
    }

    if (info.state === "frozen") {
      logger.info(`Skipping frozen token: ${mintStr}`);
      frozenMints.add(mintStr);
      skipped++;
      continue;
    }

    const uiAmount = info.tokenAmount.uiAmountString;
    const decimals = info.tokenAmount.decimals;

    logger.info(
      `Found: ${uiAmount} of ${mintStr} (${amount} raw, ${decimals} decimals)`
    );

    const sig = await sweepToken(connection, mint, pubkey, amount);
    if (sig) {
      swept++;
    } else if (frozenMints.has(mintStr)) {
      skipped++;
    } else {
      failed++;
    }

    await sleep(500);
  }

  return { swept, failed, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
