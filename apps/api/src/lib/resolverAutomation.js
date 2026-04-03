import { spawn } from "node:child_process";
import { listMarketRecords } from "./marketRegistry.js";

const activeResolvers = new Map();

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function scheduleAutoResolve(marketAddress, delayMs = 10_000) {
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
    });
  }, delayMs);

  activeResolvers.set(marketAddress, timer);
}

export function bootstrapAutoResolvers() {
  for (const record of listMarketRecords()) {
    scheduleAutoResolve(record.contractAddress, 1_000);
  }
}

