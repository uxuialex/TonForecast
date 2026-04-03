import { spawn } from "node:child_process";
import { listMarketRecords } from "./marketRegistry.js";

const activeResolvers = new Map();
const resolverRetryCounts = new Map();
const INITIAL_DELAY_MS = 10_000;
const MAX_RETRY_DELAY_MS = 60_000;
const BOOTSTRAP_LOOKBACK_SEC = 15 * 60;
const BOOTSTRAP_MAX_MARKETS = 6;

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function getRetryDelayMs(marketAddress) {
  const nextAttempt = (resolverRetryCounts.get(marketAddress) ?? 0) + 1;
  resolverRetryCounts.set(marketAddress, nextAttempt);
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * nextAttempt);
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
    child.stdout.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        console.log(`${prefix} ${message}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        console.error(`${prefix} ${message}`);
      }
    });
    child.on("exit", (code) => {
      activeResolvers.delete(marketAddress);
      console.log(`${prefix} exited with code ${code ?? 0}`);

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

export function bootstrapAutoResolvers() {
  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = listMarketRecords()
    .filter((record) => Number(record.resolveAt) >= nowSec - BOOTSTRAP_LOOKBACK_SEC)
    .sort((left, right) => Number(left.resolveAt) - Number(right.resolveAt))
    .slice(0, BOOTSTRAP_MAX_MARKETS);

  for (const [index, record] of candidates.entries()) {
    scheduleAutoResolve(record.contractAddress, 1_000 + index * 1_500);
  }
}
