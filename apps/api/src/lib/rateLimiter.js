import { incrementMetric, setGauge } from "./runtimeMetrics.js";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 5_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

const POLICY_DEFAULTS = {
  markets: { limit: 120, windowMs: DEFAULT_WINDOW_MS },
  my_markets: { limit: 30, windowMs: DEFAULT_WINDOW_MS },
  positions: { limit: 24, windowMs: DEFAULT_WINDOW_MS },
  single_position: { limit: 90, windowMs: DEFAULT_WINDOW_MS },
  create_context: { limit: 90, windowMs: DEFAULT_WINDOW_MS },
  action_write: { limit: 20, windowMs: DEFAULT_WINDOW_MS },
  admin_read: { limit: 90, windowMs: DEFAULT_WINDOW_MS },
  admin_write: { limit: 20, windowMs: DEFAULT_WINDOW_MS },
};

const buckets = new Map();
let lastSweepAtMs = 0;

function normalizeToken(value, fallback = "anonymous") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_./-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function getEnvNumber(name, fallback) {
  const numeric = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.floor(numeric);
}

function getPolicyConfig(name) {
  const defaults = POLICY_DEFAULTS[name];
  if (!defaults) {
    throw new Error(`Unknown rate limit policy: ${name}`);
  }

  const prefix = `RATE_LIMIT_${name.toUpperCase()}`;
  return {
    name,
    limit: getEnvNumber(`${prefix}_LIMIT`, defaults.limit),
    windowMs: getEnvNumber(`${prefix}_WINDOW_MS`, defaults.windowMs),
  };
}

function getClientAddress(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const candidate = forwarded
      .split(",")
      .map((value) => value.trim())
      .find(Boolean);
    if (candidate) {
      return candidate;
    }
  }

  return (
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-client-ip")?.trim() ||
    "unknown"
  );
}

function maybeSweepBuckets(nowMs = Date.now()) {
  if (nowMs - lastSweepAtMs < DEFAULT_SWEEP_INTERVAL_MS && buckets.size < DEFAULT_MAX_BUCKETS) {
    return;
  }

  const graceWindowMs = DEFAULT_WINDOW_MS * 2;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAtMs <= nowMs || nowMs - bucket.updatedAtMs > graceWindowMs) {
      buckets.delete(key);
    }
  }

  lastSweepAtMs = nowMs;
  setGauge("rate_limit_bucket_count", buckets.size);
}

function buildHeaders(policy, bucket, nowMs, blocked = false) {
  const resetMs = Math.max(0, bucket.resetAtMs - nowMs);
  const resetSec = Math.ceil(resetMs / 1000);
  return {
    "x-ratelimit-policy": policy.name,
    "x-ratelimit-limit": String(policy.limit),
    "x-ratelimit-remaining": String(Math.max(0, policy.limit - bucket.count)),
    "x-ratelimit-reset": String(resetSec),
    ...(blocked ? { "retry-after": String(Math.max(1, resetSec)) } : {}),
  };
}

export function enforceRateLimit(policyName, request, keyParts = []) {
  const policy = getPolicyConfig(policyName);
  const nowMs = Date.now();
  maybeSweepBuckets(nowMs);

  const bucketKey = [
    policy.name,
    normalizeToken(getClientAddress(request), "unknown"),
    ...keyParts.map((value, index) => normalizeToken(value, `key${index}`)),
  ].join("|");

  const bucket = buckets.get(bucketKey);
  if (!bucket || bucket.resetAtMs <= nowMs) {
    const nextBucket = {
      count: 1,
      resetAtMs: nowMs + policy.windowMs,
      updatedAtMs: nowMs,
    };
    buckets.set(bucketKey, nextBucket);
    setGauge("rate_limit_bucket_count", buckets.size);
    return buildHeaders(policy, nextBucket, nowMs);
  }

  bucket.updatedAtMs = nowMs;
  if (bucket.count >= policy.limit) {
    incrementMetric("rate_limit_rejected_total", 1, { policy: policy.name });
    const headers = buildHeaders(policy, bucket, nowMs, true);
    const error = new Error("Too many requests");
    error.statusCode = 429;
    error.headers = headers;
    throw error;
  }

  bucket.count += 1;
  return buildHeaders(policy, bucket, nowMs);
}

export function resetRateLimiter() {
  buckets.clear();
  lastSweepAtMs = 0;
  setGauge("rate_limit_bucket_count", 0);
}
