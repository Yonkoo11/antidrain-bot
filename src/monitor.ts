import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { config } from "./config";
import { logger } from "./logger";
import { sweepAllTokens } from "./sweeper";

let pollTimer: NodeJS.Timeout | null = null;
let wsSubscriptionId: number | null = null;
let isSweeeping = false;

export function startMonitor(connection: Connection): void {
  const compromisedPubkey = config.compromisedWallet.publicKey;

  logger.info(`Monitoring wallet: ${compromisedPubkey.toBase58()}`);
  logger.info(`Safe wallet: ${config.safeWallet.toBase58()}`);
  logger.info(`Sponsor: ${config.sponsorWallet.publicKey.toBase58()}`);
  logger.info(`Priority fee: ${config.priorityFee} micro-lamports`);
  logger.info(`Poll interval: ${config.pollInterval}ms`);

  // Initial sweep on startup
  triggerSweep(connection);

  // WebSocket: subscribe to token program changes involving our wallet
  startWebSocket(connection, compromisedPubkey);

  // Polling fallback
  startPolling(connection);
}

function startWebSocket(
  connection: Connection,
  wallet: PublicKey
): void {
  try {
    // Subscribe to all account changes for the compromised wallet
    // This catches incoming token transfers
    wsSubscriptionId = connection.onAccountChange(
      wallet,
      (_accountInfo, _context) => {
        logger.info("[WS] Account change detected, triggering sweep");
        triggerSweep(connection);
      },
      "confirmed"
    );

    // Also subscribe to token program logs mentioning our wallet
    // This catches new token account creation (airdrops)
    connection.onLogs(
      wallet,
      (logs) => {
        if (logs.err) return;
        logger.info(
          `[WS] Transaction log detected: ${logs.signature}`
        );
        // Delay slightly to let the tx finalize
        setTimeout(() => triggerSweep(connection), 2000);
      },
      "confirmed"
    );

    logger.info("[WS] WebSocket subscriptions active");
  } catch (err) {
    logger.warn(
      `[WS] Failed to start WebSocket: ${err instanceof Error ? err.message : err}`
    );
    logger.info("[WS] Falling back to polling only");
  }
}

function startPolling(connection: Connection): void {
  pollTimer = setInterval(() => {
    triggerSweep(connection);
  }, config.pollInterval);

  logger.info(`[POLL] Polling started every ${config.pollInterval}ms`);
}

async function triggerSweep(connection: Connection): Promise<void> {
  // Prevent overlapping sweeps
  if (isSweeeping) return;
  isSweeeping = true;

  try {
    const { swept, failed, skipped } = await sweepAllTokens(connection);
    if (swept > 0 || failed > 0) {
      logger.info(
        `Sweep complete: ${swept} succeeded, ${failed} failed, ${skipped} skipped (frozen)`
      );
    }
  } catch (err) {
    logger.error(
      `Sweep error: ${err instanceof Error ? err.message : err}`
    );
  } finally {
    isSweeeping = false;
  }
}

export function stopMonitor(connection: Connection): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (wsSubscriptionId !== null) {
    connection.removeAccountChangeListener(wsSubscriptionId).catch(() => {});
    wsSubscriptionId = null;
  }
  logger.info("Monitor stopped");
}
