import { markets } from "../../api/src/data/mockMarkets.js";
import { resolverConfig } from "./config.js";
import {
  buildResolveCommand,
  selectMarketsToResolve,
} from "./lib/marketResolver.js";

async function tick() {
  const nowIso = new Date().toISOString();
  const dueMarkets = selectMarketsToResolve(markets, nowIso);

  if (!dueMarkets.length) {
    console.log(`[resolver] no markets to resolve at ${nowIso}`);
    return;
  }

  for (const market of dueMarkets) {
    const finalPrice =
      market.token === "BTC" ? "68440" : market.token === "ETH" ? "3544" : "3.43";
    const command = buildResolveCommand(market, finalPrice);

    console.log(
      `[resolver] ${resolverConfig.dryRun ? "dry-run" : "resolve"} market=${command.marketId} outcome=${command.outcome} price=${command.finalPrice}`,
    );
  }
}

tick();
setInterval(tick, resolverConfig.pollIntervalMs);
