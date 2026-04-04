import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  beginCell,
  Cell,
  contractAddress,
  fromNano,
  storeStateInit,
  toNano,
} from "@ton/core";
import { getPreferredTonClient, withTonClientFailover } from "./runtimeEnv.js";

const OP_CREATE_MARKET = 0x6357b5ef;
const OP_BET_YES = 0x26489d83;
const OP_BET_NO = 0x67633db7;
const OP_CLAIM_REWARD = 0x3b4f6c92;

export const STATUS_UNINITIALIZED = 0;
export const STATUS_OPEN = 1;
export const STATUS_LOCKED = 2;
export const STATUS_RESOLVED_YES = 3;
export const STATUS_RESOLVED_NO = 4;
export const STATUS_RESOLVED_DRAW = 5;

export const DIRECTION_ABOVE = 0;
export const DIRECTION_BELOW = 1;

export const OUTCOME_NONE = 0;
export const OUTCOME_YES = 1;
export const OUTCOME_NO = 2;
export const OUTCOME_DRAW = 3;

export const MIN_BET_NANO = toNano("0.001");
export const DEFAULT_CREATE_VALUE_NANO = toNano("0.05");
export const DEFAULT_ACTION_VALUE_NANO = toNano("0.05");
const DEFAULT_RPC_MAX_RETRIES = 4;
const USER_STAKE_RPC_MAX_RETRIES = 2;
const RPC_CALL_TIMEOUT_MS = 4_000;
const MARKET_STATE_CACHE_TTL_MS = 8_000;
const USER_STAKE_CACHE_TTL_MS = 8_000;
const openedContracts = new Map();
const marketStateCache = new Map();
const marketStateInflight = new Map();
const userStakeCache = new Map();
const userStakeInflight = new Map();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildArtifactPath = path.resolve(
  __dirname,
  "../../../../build/TonForecastMarket.compiled.json",
);
const buildArtifact = JSON.parse(fs.readFileSync(buildArtifactPath, "utf8"));
const codeCell = Cell.fromBoc(Buffer.from(buildArtifact.hex, "hex"))[0];

export const TON_FORECAST_MARKET_CONTRACT_VERSION = "v2-uncontested-draw";
export const TON_FORECAST_MARKET_CODE_HASH = buildArtifact.hash;
export const TON_FORECAST_MARKET_CODE_HASH_BASE64 = buildArtifact.hashBase64;

function isZeroAddress(address) {
  return [...address.hash].every((byte) => byte === 0);
}

export function parseAddress(input) {
  return Address.parse(typeof input === "string" ? input : input.toString());
}

export function addressToString(input) {
  return parseAddress(input).toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isRateLimitError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error;
  return candidate.response?.status === 429 ||
    candidate.status === 429 ||
    candidate.message?.includes("429") === true;
}

async function withRpcRetry(label, task, options = {}) {
  const maxRetries = Number(options.maxRetries ?? DEFAULT_RPC_MAX_RETRIES);

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!isRateLimitError(error) || attempt === maxRetries - 1) {
        throw error;
      }

      const delayMs = Math.min(10_000, 1_000 * (attempt + 1));
      console.warn(`[api] ${label} hit RPC rate limit, retry in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw new Error(`[api] ${label} exceeded retry budget`);
}

function getCachedValue(cache, key) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAtMs <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCachedValue(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAtMs: Date.now() + ttlMs,
  });
  return value;
}

async function getCachedAsync(cache, inflight, key, ttlMs, task) {
  const cached = getCachedValue(cache, key);
  if (cached) {
    return cached;
  }

  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = (async () => {
    try {
      const value = await task();
      return setCachedValue(cache, key, value, ttlMs);
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function encodeAssetId(assetId) {
  const bytes = Buffer.from(assetId, "utf8");
  if (bytes.length > 8) {
    throw new Error(`Asset id "${assetId}" is too long for uint64 base256 encoding`);
  }

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

export function decodeAssetId(value) {
  if (!value || value === 0n) {
    return "";
  }

  const bytes = [];
  let current = BigInt(value);
  while (current > 0n) {
    bytes.unshift(Number(current & 0xffn));
    current >>= 8n;
  }

  return Buffer.from(bytes).toString("utf8");
}

export function toPrice6(value) {
  const text = String(value);
  const [wholePart, fractionPart = ""] = text.split(".");
  const normalizedFraction = (fractionPart + "000000").slice(0, 6);
  return BigInt(wholePart) * 1_000_000n + BigInt(normalizedFraction);
}

export function formatPrice6(value) {
  const negative = BigInt(value) < 0n;
  const abs = negative ? -BigInt(value) : BigInt(value);
  const whole = abs / 1_000_000n;
  const fraction = String(abs % 1_000_000n).padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export function nanosToTonDecimal(value) {
  return Number(fromNano(BigInt(value)));
}

export function statusToLabel(status) {
  switch (status) {
    case STATUS_UNINITIALIZED:
      return "UNINITIALIZED";
    case STATUS_OPEN:
      return "OPEN";
    case STATUS_LOCKED:
      return "LOCKED";
    case STATUS_RESOLVED_YES:
      return "RESOLVED_YES";
    case STATUS_RESOLVED_NO:
      return "RESOLVED_NO";
    case STATUS_RESOLVED_DRAW:
      return "RESOLVED_DRAW";
    default:
      return `UNKNOWN_${status}`;
  }
}

export function outcomeToLabel(outcome) {
  switch (outcome) {
    case OUTCOME_NONE:
      return "NONE";
    case OUTCOME_YES:
      return "YES";
    case OUTCOME_NO:
      return "NO";
    case OUTCOME_DRAW:
      return "DRAW";
    default:
      return `UNKNOWN_${outcome}`;
  }
}

function createConfigCell({ ownerAddress, resolverAddress, deploymentSalt }) {
  const owner = parseAddress(ownerAddress);
  const resolver = parseAddress(resolverAddress);

  if (isZeroAddress(owner)) {
    throw new Error("ownerAddress must not be zero address");
  }
  if (isZeroAddress(resolver)) {
    throw new Error("resolverAddress must not be zero address");
  }

  const marketMeta = beginCell()
    .storeUint(0, 64)
    .storeUint(0, 64)
    .storeUint(0, 128)
    .storeUint(DIRECTION_ABOVE, 8)
    .storeUint(0, 64)
    .storeUint(0, 64)
    .endCell();

  const marketRuntime = beginCell()
    .storeUint(STATUS_UNINITIALIZED, 8)
    .storeCoins(0)
    .storeCoins(0)
    .storeUint(0, 128)
    .storeUint(OUTCOME_NONE, 8)
    .endCell();

  return beginCell()
    .storeAddress(owner)
    .storeAddress(resolver)
    .storeUint(BigInt(deploymentSalt), 64)
    .storeRef(marketMeta)
    .storeRef(marketRuntime)
    .storeBit(0)
    .endCell();
}

function createCreateMarketBody({
  marketId,
  assetId,
  threshold,
  direction = DIRECTION_ABOVE,
  closeTime,
  resolveTime,
}) {
  const encodedAssetId = typeof assetId === "string" ? encodeAssetId(assetId) : BigInt(assetId);

  return beginCell()
    .storeUint(OP_CREATE_MARKET, 32)
    .storeUint(BigInt(marketId), 64)
    .storeUint(encodedAssetId, 64)
    .storeUint(BigInt(threshold), 128)
    .storeUint(direction, 8)
    .storeUint(BigInt(closeTime), 64)
    .storeUint(BigInt(resolveTime), 64)
    .endCell();
}

export function createBetBody(side) {
  return beginCell()
    .storeUint(side === "YES" ? OP_BET_YES : OP_BET_NO, 32)
    .endCell();
}

export function createClaimBody() {
  return beginCell().storeUint(OP_CLAIM_REWARD, 32).endCell();
}

function toBase64(cell) {
  return cell.toBoc({ idx: false }).toString("base64");
}

export function createCreateMarketIntent({
  ownerAddress,
  resolverAddress,
  deploymentSalt,
  marketId,
  assetId,
  threshold,
  closeTime,
  resolveTime,
  direction = DIRECTION_ABOVE,
}) {
  const data = createConfigCell({
    ownerAddress,
    resolverAddress,
    deploymentSalt,
  });
  const init = {
    code: codeCell,
    data,
  };
  const address = contractAddress(0, init);
  const stateInit = beginCell().store(storeStateInit(init)).endCell();
  const payload = createCreateMarketBody({
    marketId,
    assetId,
    threshold,
    direction,
    closeTime,
    resolveTime,
  });

  return {
    address,
    stateInit,
    payload,
    message: {
      address: address.toString(),
      amount: DEFAULT_CREATE_VALUE_NANO.toString(),
      payload: toBase64(payload),
      stateInit: toBase64(stateInit),
    },
  };
}

class TonForecastMarketContract {
  constructor(address) {
    this.address = parseAddress(address);
  }

  async getMarketState(provider) {
    const result = await withRpcRetry("get_market_state", () =>
      withTimeout(provider.get("get_market_state", []), RPC_CALL_TIMEOUT_MS, "get_market_state"),
    );
    const marketId = result.stack.readBigNumber();
    const assetId = result.stack.readBigNumber();
    const threshold = result.stack.readBigNumber();
    const direction = result.stack.readNumber();
    const closeTime = result.stack.readBigNumber();
    const resolveTime = result.stack.readBigNumber();
    const status = result.stack.readNumber();
    const yesPool = result.stack.readBigNumber();
    const noPool = result.stack.readBigNumber();
    const finalPrice = result.stack.readBigNumber();
    const resolvedOutcome = result.stack.readNumber();

    return {
      marketId,
      assetId,
      assetIdText: decodeAssetId(assetId),
      threshold,
      direction,
      closeTime,
      resolveTime,
      status,
      yesPool,
      noPool,
      finalPrice,
      resolvedOutcome,
    };
  }

  async getUserStake(provider, userAddress) {
    const result = await withRpcRetry(
      "get_user_stake",
      () =>
        withTimeout(
          provider.get("get_user_stake", [
            { type: "slice", cell: beginCell().storeAddress(parseAddress(userAddress)).endCell() },
          ]),
          RPC_CALL_TIMEOUT_MS,
          "get_user_stake",
        ),
      { maxRetries: USER_STAKE_RPC_MAX_RETRIES },
    );

    return {
      yesAmount: result.stack.readBigNumber(),
      noAmount: result.stack.readBigNumber(),
      claimed: result.stack.readBoolean(),
    };
  }
}

export function openMarketContract(address) {
  const normalized = parseAddress(address).toString();
  const preferredProvider = getPreferredTonClient();
  const providerKey = preferredProvider?.id ?? "default";
  const cacheKey = `${providerKey}:${normalized}`;
  const existing = openedContracts.get(cacheKey);
  if (existing) {
    return existing;
  }

  const client = preferredProvider.client;
  const opened = client.open(new TonForecastMarketContract(normalized));
  openedContracts.set(cacheKey, opened);
  return opened;
}

function openMarketContractForProvider(address, provider) {
  const normalized = parseAddress(address).toString();
  const providerKey = provider?.id ?? "default";
  const cacheKey = `${providerKey}:${normalized}`;
  const existing = openedContracts.get(cacheKey);
  if (existing) {
    return existing;
  }

  const opened = provider.client.open(new TonForecastMarketContract(normalized));
  openedContracts.set(cacheKey, opened);
  return opened;
}

async function callMarketWithFailover(address, label, task) {
  const normalized = parseAddress(address).toString();
  return withTonClientFailover(label, async (_client, provider) => {
    const contract = openMarketContractForProvider(normalized, provider);
    return task(contract, provider);
  });
}

export async function getCachedMarketState(address) {
  const normalized = parseAddress(address).toString();
  return getCachedAsync(
    marketStateCache,
    marketStateInflight,
    normalized,
    MARKET_STATE_CACHE_TTL_MS,
    () => callMarketWithFailover(normalized, "get_market_state", (contract) => contract.getMarketState()),
  );
}

export async function getCachedUserStake(address, userAddress) {
  const normalizedAddress = parseAddress(address).toString();
  const normalizedUser = parseAddress(userAddress).toString();
  const cacheKey = `${normalizedAddress}:${normalizedUser}`;

  return getCachedAsync(
    userStakeCache,
    userStakeInflight,
    cacheKey,
    USER_STAKE_CACHE_TTL_MS,
    () =>
      callMarketWithFailover(normalizedAddress, "get_user_stake", (contract) =>
        contract.getUserStake(normalizedUser),
      ),
  );
}

export function invalidateContractCaches(address) {
  const normalized = parseAddress(address).toString();
  marketStateCache.delete(normalized);
  marketStateInflight.delete(normalized);

  for (const key of openedContracts.keys()) {
    if (key.endsWith(`:${normalized}`)) {
      openedContracts.delete(key);
    }
  }

  for (const key of userStakeCache.keys()) {
    if (key.startsWith(`${normalized}:`)) {
      userStakeCache.delete(key);
    }
  }

  for (const key of userStakeInflight.keys()) {
    if (key.startsWith(`${normalized}:`)) {
      userStakeInflight.delete(key);
    }
  }
}
