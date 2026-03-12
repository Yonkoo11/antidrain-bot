import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { config } from "./config";
import { logger } from "./logger";
import { sweepAllTokens } from "./sweeper";

let pollTimer: NodeJS.Timeout | null = null;
let wsSubscriptionId: number | null = null;
let logsSubscriptionId: number | null = null;
let isSweeeping = false;
let consecutiveErrors = 0;
let wsAlive = false;

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

  // Polling fallback (slower when WS is healthy)
  startPolling(connection);
}

function startWebSocket(
  connection: Connection,
  wallet: PublicKey
): void {
  try {
    // Subscribe to all account changes for the compromised wallet
    wsSubscriptionId = connection.onAccountChange(
      wallet,
      (_accountInfo, _context) => {
        wsAlive = true;
        consecutiveErrors = 0;
        logger.info("[WS] Account change detected, triggering sweep");
        triggerSweep(connection);
      },
      "confirmed"
    );

    // Also subscribe to token program logs mentioning our wallet
    logsSubscriptionId = connection.onLogs(
      wallet,
      (logs) => {
        wsAlive = true;
        consecutiveErrors = 0;
        if (logs.err) return;
        logger.info(
          `[WS] Transaction log detected: ${logs.signature}`
        );
        setTimeout(() => triggerSweep(connection), 2000);
      },
      "confirmed"
    );

    wsAlive = true;
    logger.info("[WS] WebSocket subscriptions active");

    // Periodically check if WS is still alive and reconnect if needed
    setInterval(() => {
      reconnectWebSocket(connection, wallet);
    }, 30_000);
  } catch (err) {
    wsAlive = false;
    logger.warn(
      `[WS] Failed to start WebSocket: ${err instanceof Error ? err.message : err}`
    );
    logger.info("[WS] Falling back to polling only");
  }
}

async function reconnectWebSocket(
  connection: Connection,
  wallet: PublicKey
): Promise<void> {
  // If we've had many consecutive poll errors, WS is likely dead too
  if (consecutiveErrors >= 3 && wsAlive) {
    logger.warn("[WS] Consecutive errors detected, marking WS as potentially dead");
    wsAlive = false;
  }

  if (!wsAlive) {
    logger.info("[WS] Attempting reconnect...");
    try {
      if (wsSubscriptionId !== null) {
        connection.removeAccountChangeListener(wsSubscriptionId).catch(() => {});
      }
      if (logsSubscriptionId !== null) {
        connection.removeOnLogsListener(logsSubscriptionId).catch(() => {});
      }
    } catch {}

    try {
      wsSubscriptionId = connection.onAccountChange(
        wallet,
        (_accountInfo, _context) => {
          wsAlive = true;
          consecutiveErrors = 0;
          logger.info("[WS] Account change detected, triggering sweep");
          triggerSweep(connection);
        },
        "confirmed"
      );

      logsSubscriptionId = connection.onLogs(
        wallet,
        (logs) => {
          wsAlive = true;
          consecutiveErrors = 0;
          if (logs.err) return;
          logger.info(`[WS] Transaction log detected: ${logs.signature}`);
          setTimeout(() => triggerSweep(connection), 2000);
        },
        "confirmed"
      );

      wsAlive = true;
      logger.info("[WS] Reconnected successfully");
    } catch (err) {
      wsAlive = false;
      logger.warn(`[WS] Reconnect failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function startPolling(connection: Connection): void {
  // Use dynamic interval: poll faster when WS is down, slower when healthy
  const poll = () => {
    triggerSweep(connection).finally(() => {
      // Backoff: base interval * 2^errors, capped at 60s
      // When WS is alive, poll at 2x base interval (less aggressive)
      const backoffMs = consecutiveErrors > 0
        ? Math.min(config.pollInterval * Math.pow(2, consecutiveErrors), 60_000)
        : wsAlive
          ? config.pollInterval * 2
          : config.pollInterval;

      pollTimer = setTimeout(poll, backoffMs);
    });
  };

  pollTimer = setTimeout(poll, config.pollInterval);
  logger.info(`[POLL] Polling started (base interval: ${config.pollInterval}ms)`);
}

async function triggerSweep(connection: Connection): Promise<void> {
  if (isSweeeping) return;
  isSweeeping = true;

  try {
    const { swept, failed, skipped } = await sweepAllTokens(connection);
    // Reset error counter on successful RPC call
    consecutiveErrors = 0;
    if (swept > 0 || failed > 0) {
      logger.info(
        `Sweep complete: ${swept} succeeded, ${failed} failed, ${skipped} skipped (frozen)`
      );
    }
  } catch (err) {
    consecutiveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    // Only log at error level for first occurrence, then warn to reduce noise
    if (consecutiveErrors <= 1) {
      logger.error(`Sweep error: ${msg}`);
    } else {
      logger.warn(
        `Sweep error (${consecutiveErrors} consecutive): ${msg} - backing off`
      );
    }
  } finally {
    isSweeeping = false;
  }
}

export function stopMonitor(connection: Connection): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (wsSubscriptionId !== null) {
    connection.removeAccountChangeListener(wsSubscriptionId).catch(() => {});
    wsSubscriptionId = null;
  }
  if (logsSubscriptionId !== null) {
    connection.removeOnLogsListener(logsSubscriptionId).catch(() => {});
    logsSubscriptionId = null;
  }
  logger.info("Monitor stopped");
}
