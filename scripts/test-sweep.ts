/**
 * One-shot sweep: scan and sweep all tokens once, then exit.
 * Usage: npm run test-sweep
 */
import { Connection } from "@solana/web3.js";
import { config } from "../src/config";
import { logger } from "../src/logger";
import { sweepAllTokens, setConnections } from "../src/sweeper";

async function main() {
  logger.info("=== Antidrain Test Sweep (one-shot) ===");

  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
  });

  // Set up fallback if configured
  let fallback: Connection | null = null;
  if (config.fallbackRpcUrl) {
    fallback = new Connection(config.fallbackRpcUrl, {
      commitment: "confirmed",
    });
  }
  setConnections(connection, fallback);

  // Verify connectivity
  const slot = await connection.getSlot();
  logger.info(`Connected (slot: ${slot})`);

  // Check balances
  const sponsorBal = await connection.getBalance(
    config.sponsorWallet.publicKey
  );
  logger.info(`Sponsor balance: ${sponsorBal / 1e9} SOL`);

  const compromisedBal = await connection.getBalance(
    config.compromisedWallet.publicKey
  );
  logger.info(`Compromised wallet balance: ${compromisedBal / 1e9} SOL`);

  // Sweep once
  const { swept, failed, skipped } = await sweepAllTokens(connection);
  logger.info(`Done: ${swept} swept, ${failed} failed, ${skipped} skipped`);

  process.exit(0);
}

main().catch((err) => {
  logger.error(`Error: ${err}`);
  process.exit(1);
});
