import { spawn } from "node:child_process";
import { listMarketRecords, saveMarketRecord } from "./marketRegistry.js";

const activeResolvers = new Map();
const resolverRetryCounts = new Map();
const INITIAL_DELAY_MS = 10_000;
const MAX_RETRY_DELAY_MS = 60_000;
const AUTO_RESOLVE_LOOKAHEAD_SEC = 10 * 60;
const AUTO_RESOLVE_SWEEP_INTERVAL_MS = 60_000;
const AUTO_RESOLVE_BLOCKED_EXIT_CODE = 42;
const BLOCKED_PREFIX = "[resolver-blocked]";
let sweepTimer = null;

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function getRetryDelayMs(marketAddress) {
  const nextAttempt = (resolverRetryCounts.get(marketAddress) ?? 0) + 1;
  resolverRetryCounts.set(marketAddress, nextAttempt);
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * nextAttempt);
}

function captureBlockedReason(output, currentReason) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith(BLOCKED_PREFIX)) {
      return line.slice(BLOCKED_PREFIX.length).trim() || currentReason;
    }
  }

  return currentReason;
}

export function scheduleAutoResolve(marketAddress, delayMs = INITIAL_DELAY_MS) {
  if (!marketAddress || activeResolvers.has(marketAddress)) {
    return;
  }

  const timer = setTimeout(() => {
    const child = spawn(
      getNpmCommand(),
      ["run", "resolver:auto", "--", marketAddress],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MARKET_ADDRESS: marketAddress,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    activeResolvers.set(marketAddress, child);

    const prefix = `[auto-resolver:${marketAddress}]`;
    let blockedReason = null;
    child.stdout.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        blockedReason = captureBlockedReason(message, blockedReason);
        console.log(`${prefix} ${message}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        blockedReason = captureBlockedReason(message, blockedReason);
        console.error(`${prefix} ${message}`);
      }
    });
    child.on("exit", (code) => {
      activeResolvers.delete(marketAddress);
      console.log(`${prefix} exited with code ${code ?? 0}`);

      if ((code ?? 0) === AUTO_RESOLVE_BLOCKED_EXIT_CODE) {
        resolverRetryCounts.delete(marketAddress);
        saveMarketRecord({
          contractAddress: marketAddress,
          autoResolveBlockedAt: Math.floor(Date.now() / 1000),
          autoResolveBlockedReason:
            blockedReason || "Permanent auto-resolve failure detected",
        });
        console.warn(
          `${prefix} disabled future auto-resolve attempts: ${blockedReason || "permanent failure"}`,
        );
        return;
      }

      if ((code ?? 0) !== 0) {
        const retryDelayMs = getRetryDelayMs(marketAddress);
        console.warn(`${prefix} retrying in ${retryDelayMs}ms after failed run`);
        scheduleAutoResolve(marketAddress, retryDelayMs);
        return;
      }

      resolverRetryCounts.delete(marketAddress);
    });
  }, delayMs);

  activeResolvers.set(marketAddress, timer);
}

function isResolvedRecord(record) {
  return typeof record?.lastKnownStatus === "string" && record.lastKnownStatus.startsWith("RESOLVED");
}

function isAutoResolvableRecord(record, nowSec) {
  if (
    !record?.contractAddress ||
    record.createFailedAt ||
    record.autoResolveBlockedAt ||
    isResolvedRecord(record)
  ) {
    return false;
  }

  const resolveAt = Number(record.resolveAt ?? 0);
  if (!Number.isFinite(resolveAt) || resolveAt <= 0) {
    return false;
  }

  return resolveAt <= nowSec + AUTO_RESOLVE_LOOKAHEAD_SEC;
}

function getAutoResolveDelayMs(record, nowSec) {
  const resolveAt = Number(record.resolveAt ?? 0);
  if (!Number.isFinite(resolveAt) || resolveAt <= nowSec) {
    return 1_000;
  }

  return Math.max(1_000, (resolveAt - nowSec) * 1_000 + 1_000);
}

export function scheduleAutoResolveForRecord(record, nowSec = Math.floor(Date.now() / 1000)) {
  if (!isAutoResolvableRecord(record, nowSec)) {
    return false;
  }

  scheduleAutoResolve(record.contractAddress, getAutoResolveDelayMs(record, nowSec));
  return true;
}

export function runAutoResolverSweep() {
  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = listMarketRecords()
    .filter((record) => isAutoResolvableRecord(record, nowSec))
    .sort((left, right) => Number(left.resolveAt) - Number(right.resolveAt));

  for (const record of candidates) {
    scheduleAutoResolveForRecord(record, nowSec);
  }

  return candidates.length;
}

export function bootstrapAutoResolvers() {
  runAutoResolverSweep();

  if (sweepTimer) {
    return;
  }

  sweepTimer = setInterval(() => {
    try {
      runAutoResolverSweep();
    } catch (error) {
      console.error(
        `[auto-resolver] sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, AUTO_RESOLVE_SWEEP_INTERVAL_MS);

  sweepTimer.unref?.();
}
