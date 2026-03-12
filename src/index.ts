import { Connection } from "@solana/web3.js";
import { config } from "./config";
import { logger } from "./logger";
import { startMonitor, stopMonitor } from "./monitor";
import { setConnections } from "./sweeper";
import { setClaimerConnections, watchClaimsFile } from "./claimer";

async function main(): Promise<void> {
  logger.info("=== Antidrain Bot Starting ===");

  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: config.wsUrl,
  });

  // Verify primary RPC
  try {
    const slot = await connection.getSlot();
    logger.info(`Primary RPC connected (slot: ${slot})`);
  } catch (err) {
    logger.error(`Failed to connect to primary RPC: ${config.rpcUrl}`);
    process.exit(1);
  }

  // Set up fallback RPC if configured
  let fallbackConnection: Connection | null = null;
  if (config.fallbackRpcUrl) {
    fallbackConnection = new Connection(config.fallbackRpcUrl, {
      commitment: "confirmed",
      wsEndpoint: config.fallbackWsUrl || undefined,
    });
    try {
      const slot = await fallbackConnection.getSlot();
      logger.info(`Fallback RPC connected (slot: ${slot})`);
    } catch (err) {
      logger.warn("Fallback RPC failed to connect, continuing with primary only");
      fallbackConnection = null;
    }
  }

  // Pass both connections to sweeper and claimer
  setConnections(connection, fallbackConnection);
  setClaimerConnections(connection, fallbackConnection);

  // Check sponsor balance
  const sponsorBalance = await connection.getBalance(
    config.sponsorWallet.publicKey
  );
  const sponsorSol = sponsorBalance / 1e9;
  logger.info(`Sponsor balance: ${sponsorSol} SOL`);

  if (sponsorBalance < 5_000_000) {
    logger.warn(
      "Sponsor balance is very low. Fund it with SOL for gas fees."
    );
  }

  // Start monitoring and claim watcher
  startMonitor(connection);
  watchClaimsFile(connection);

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    stopMonitor(connection);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Bot is running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
