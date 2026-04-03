import { determineOutcome } from "../../../../packages/shared/src/index.js";

export function selectMarketsToResolve(markets, nowIso) {
  const now = new Date(nowIso).getTime();
  return markets.filter((market) => {
    return market.status === "LOCKED" && market.resolveAt * 1000 <= now;
  });
}

export function buildResolveCommand(market, finalPrice) {
  return {
    marketId: market.id,
    finalPrice,
    outcome: determineOutcome({
      direction: market.direction,
      threshold: market.threshold,
      finalPrice,
    }),
  };
}
