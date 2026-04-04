import fs from "node:fs";
import path from "node:path";
import { mnemonicToWalletKey } from "@ton/crypto";
import { TonClient, WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import { incrementMetric, recordRuntimeEvent } from "./runtimeMetrics.js";

const DEFAULT_MAINNET_ENDPOINT = "https://toncenter.com/api/v2/jsonRPC";
const DEFAULT_RESOLVER_WALLET_VERSION = "v5r1";
const DEFAULT_RPC_FAILURE_THRESHOLD = 3;
const DEFAULT_RPC_COOLDOWN_MS = 30_000;
const DEFAULT_ADMIN_ALLOWED_WALLETS = [
  "UQDBTlOU6i2kcUOkSK4EEfEgZTaG4zkOSTY6R1nZiTMYZbEO",
];

let envLoaded = false;
let tonClientPool = null;
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

function readEnvList(name) {
  loadLocalEnv();
  return String(process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueNonEmpty(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

export function getEndpoint() {
  loadLocalEnv();
  return process.env.TON_API_ENDPOINT?.trim() || DEFAULT_MAINNET_ENDPOINT;
}

export function getApiKey() {
  loadLocalEnv();
  return process.env.TON_API_KEY?.trim() || process.env.TONCENTER_API_KEY?.trim() || undefined;
}

function getApiKeys() {
  const explicitKeys = readEnvList("TON_API_KEYS");
  if (explicitKeys.length) {
    return explicitKeys;
  }

  const singleKey = getApiKey();
  return singleKey ? [singleKey] : [];
}

export function getTonRpcEndpoints() {
  const configured = uniqueNonEmpty([
    ...readEnvList("TON_API_ENDPOINTS"),
    getEndpoint(),
    ...readEnvList("TON_API_FALLBACK_ENDPOINTS"),
  ]);
  return configured.length ? configured : [DEFAULT_MAINNET_ENDPOINT];
}

function getRpcFailureThreshold() {
  loadLocalEnv();
  const value = Number(process.env.TON_RPC_FAILURE_THRESHOLD ?? DEFAULT_RPC_FAILURE_THRESHOLD);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RPC_FAILURE_THRESHOLD;
}

function getRpcCooldownMs() {
  loadLocalEnv();
  const value = Number(process.env.TON_RPC_COOLDOWN_MS ?? DEFAULT_RPC_COOLDOWN_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RPC_COOLDOWN_MS;
}

function buildTonClientPool() {
  const endpoints = getTonRpcEndpoints();
  const apiKeys = getApiKeys();
  return endpoints.map((endpoint, index) => ({
    id: `rpc${index + 1}`,
    endpoint,
    apiKey: apiKeys[index] ?? apiKeys[0] ?? undefined,
    client: new TonClient({
      endpoint,
      apiKey: apiKeys[index] ?? apiKeys[0] ?? undefined,
    }),
    failures: 0,
    successes: 0,
    blockedUntilMs: 0,
    lastError: "",
    lastFailureAtMs: 0,
    lastSuccessAtMs: 0,
  }));
}

function getTonClientPool() {
  if (!tonClientPool) {
    tonClientPool = buildTonClientPool();
  }

  return tonClientPool;
}

function getProviderLabel(provider) {
  try {
    return new URL(provider.endpoint).host;
  } catch {
    return provider.endpoint;
  }
}

export function isRetryableTonRpcError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error;
  if (candidate.response?.status === 429 || candidate.status === 429) {
    return true;
  }

  const statusCode = Number(candidate.response?.status ?? candidate.statusCode ?? candidate.status ?? 0);
  if (statusCode >= 500) {
    return true;
  }

  const message = candidate.message ?? String(error);
  return /429|timed out|timeout|fetch failed|network|eai_again|socket|connection reset/i.test(message);
}

function markTonProviderSuccess(provider, label) {
  provider.failures = 0;
  provider.successes += 1;
  provider.blockedUntilMs = 0;
  provider.lastError = "";
  provider.lastSuccessAtMs = Date.now();
  incrementMetric("ton_rpc_success_total", 1, { provider: provider.id, label });
}

function markTonProviderFailure(provider, error, label) {
  provider.failures += 1;
  provider.lastError = error instanceof Error ? error.message : String(error);
  provider.lastFailureAtMs = Date.now();
  incrementMetric("ton_rpc_failure_total", 1, { provider: provider.id, label });

  if (provider.failures >= getRpcFailureThreshold()) {
    provider.blockedUntilMs = Date.now() + getRpcCooldownMs();
    recordRuntimeEvent("ton-rpc-provider-blocked", {
      provider: provider.id,
      endpoint: getProviderLabel(provider),
      label,
      reason: provider.lastError,
      blockedUntilMs: provider.blockedUntilMs,
    });
    incrementMetric("ton_rpc_provider_block_total", 1, { provider: provider.id });
  }
}

function getOrderedTonProviders() {
  const providers = getTonClientPool();
  const nowMs = Date.now();
  const healthyProviders = providers.filter((provider) => provider.blockedUntilMs <= nowMs);
  if (healthyProviders.length) {
    return healthyProviders;
  }

  return [...providers].sort((left, right) => left.blockedUntilMs - right.blockedUntilMs);
}

export function getTonRpcPoolSnapshot() {
  const nowMs = Date.now();
  return getTonClientPool().map((provider) => ({
    id: provider.id,
    endpoint: provider.endpoint,
    label: getProviderLabel(provider),
    failures: provider.failures,
    successes: provider.successes,
    blocked: provider.blockedUntilMs > nowMs,
    blockedUntilMs: provider.blockedUntilMs,
    lastError: provider.lastError,
    lastFailureAtMs: provider.lastFailureAtMs || null,
    lastSuccessAtMs: provider.lastSuccessAtMs || null,
  }));
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
  return getPreferredTonClient().client;
}

export function getPreferredTonClient() {
  return getOrderedTonProviders()[0];
}

export async function withTonClientFailover(label, task) {
  const providers = getOrderedTonProviders();
  let lastError = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    incrementMetric("ton_rpc_attempt_total", 1, {
      provider: provider.id,
      label,
    });

    try {
      const result = await task(provider.client, provider);
      markTonProviderSuccess(provider, label);
      if (index > 0) {
        incrementMetric("ton_rpc_failover_success_total", 1, { label });
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryableTonRpcError(error)) {
        throw error;
      }

      markTonProviderFailure(provider, error, label);
      if (index < providers.length - 1) {
        recordRuntimeEvent("ton-rpc-failover", {
          label,
          fromProvider: provider.id,
          fromEndpoint: getProviderLabel(provider),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throw lastError ?? new Error(`All TON RPC providers failed for ${label}`);
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

export function getAdminToken() {
  loadLocalEnv();
  return process.env.ADMIN_TOKEN?.trim() || "";
}

export function getAdminAllowedWallets() {
  loadLocalEnv();
  const configured = readEnvList("ADMIN_ALLOWED_WALLETS");
  return configured.length ? configured : [...DEFAULT_ADMIN_ALLOWED_WALLETS];
}
