import fs from "node:fs";
import path from "node:path";
import { mnemonicToWalletKey } from "@ton/crypto";
import { TonClient, WalletContractV4, WalletContractV5R1 } from "@ton/ton";

const DEFAULT_MAINNET_ENDPOINT = "https://toncenter.com/api/v2/jsonRPC";
const DEFAULT_RESOLVER_WALLET_VERSION = "v5r1";

let envLoaded = false;
let tonClient = null;
let resolverWalletPromise = null;

function loadLocalEnv() {
  if (envLoaded) {
    return;
  }

  envLoaded = true;

  for (const candidate of [".env.local", ".env"]) {
    const filePath = path.resolve(process.cwd(), candidate);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const source = fs.readFileSync(filePath, "utf8");
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

function getRequiredEnv(name) {
  loadLocalEnv();
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getEndpoint() {
  loadLocalEnv();
  return process.env.TON_API_ENDPOINT?.trim() || DEFAULT_MAINNET_ENDPOINT;
}

export function getApiKey() {
  loadLocalEnv();
  return process.env.TON_API_KEY?.trim() || process.env.TONCENTER_API_KEY?.trim() || undefined;
}

export function getResolverWalletVersion() {
  loadLocalEnv();
  const raw = process.env.RESOLVER_WALLET_VERSION?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_RESOLVER_WALLET_VERSION;
  }

  if (raw === "v4" || raw === "v5r1") {
    return raw;
  }

  throw new Error(`Invalid RESOLVER_WALLET_VERSION: ${raw}`);
}

export function getTonClient() {
  if (!tonClient) {
    tonClient = new TonClient({
      endpoint: getEndpoint(),
      apiKey: getApiKey(),
    });
  }

  return tonClient;
}

export async function getResolverWalletInfo() {
  if (!resolverWalletPromise) {
    resolverWalletPromise = (async () => {
      const mnemonic = getRequiredEnv("RESOLVER_MNEMONIC")
        .split(/\s+/)
        .filter(Boolean);
      const keyPair = await mnemonicToWalletKey(mnemonic);
      const walletVersion = getResolverWalletVersion();
      const wallet = walletVersion === "v4"
        ? WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
          })
        : WalletContractV5R1.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
          });

      return {
        walletVersion,
        address: wallet.address,
      };
    })();
  }

  return resolverWalletPromise;
}

export function ensureRuntimeEnvLoaded() {
  loadLocalEnv();
}
