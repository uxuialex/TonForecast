import { buildMarketQuestion } from "../../../../packages/shared/src/index.js";
import { markets, positions } from "../data/mockMarkets.js";

export async function listMarkets(status) {
  const items = status ? markets.filter((item) => item.status === status) : markets;

  return items.map((item) => ({
    ...item,
    question: item.question ?? buildMarketQuestion(item),
  }));
}

export async function getMarketById(marketId) {
  const market = markets.find((item) => item.id === marketId);
  if (!market) {
    return null;
  }

  return {
    ...market,
    question: market.question ?? buildMarketQuestion(market),
  };
}

export async function listPositions(userAddress) {
  return positions.filter((item) => item.userAddress === userAddress);
}
