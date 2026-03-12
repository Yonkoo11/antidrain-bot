import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 = require("bs58");
import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    console.error(`Copy .env.example to .env and fill in your values.`);
    process.exit(1);
  }
  return val;
}

function loadKeypair(base58Key: string, label: string): Keypair {
  try {
    const decoded = bs58.decode(base58Key);
    return Keypair.fromSecretKey(decoded);
  } catch {
    console.error(`Invalid ${label} private key. Must be base58 encoded.`);
    process.exit(1);
  }
}

const compromisedKey = requireEnv("COMPROMISED_PRIVATE_KEY");
const sponsorKey = requireEnv("SPONSOR_PRIVATE_KEY");
const safeAddress = requireEnv("SAFE_WALLET_ADDRESS");

export const config = {
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  wsUrl: process.env.WS_URL || "wss://api.mainnet-beta.solana.com",
  fallbackRpcUrl: process.env.FALLBACK_RPC_URL || null,
  fallbackWsUrl: process.env.FALLBACK_WS_URL || null,
  compromisedWallet: loadKeypair(compromisedKey, "COMPROMISED_PRIVATE_KEY"),
  sponsorWallet: loadKeypair(sponsorKey, "SPONSOR_PRIVATE_KEY"),
  safeWallet: new PublicKey(safeAddress),
  priorityFee: parseInt(process.env.PRIORITY_FEE || "500000", 10),
  pollInterval: parseInt(process.env.POLL_INTERVAL || "5000", 10),
  logFile: process.env.LOG_FILE || "antidrain.log",
};
