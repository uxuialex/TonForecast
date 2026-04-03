export const SUPPORTED_ASSETS = ["TON", "BTC", "ETH"];
export const MARKET_DURATIONS = [30, 60];
export const MARKET_DIRECTIONS = ["above", "below"];
export const MARKET_STATUSES = [
  "OPEN",
  "LOCKED",
  "RESOLVED_YES",
  "RESOLVED_NO",
];
export const POSITION_STATUSES = ["OPEN", "WON", "LOST", "CLAIMED"];
export const POSITION_SIDES = ["YES", "NO"];

export function buildMarketQuestion(input) {
  return `Will ${input.token} be ${input.direction} $${input.threshold} in ${input.durationSec} seconds?`;
}

export function determineOutcome(input) {
  const threshold = Number(input.threshold);
  const finalPrice = Number(input.finalPrice);

  if (input.direction === "above") {
    return finalPrice > threshold ? "YES" : "NO";
  }

  return finalPrice < threshold ? "YES" : "NO";
}

export function calculatePayout(params) {
  const winnerPool = Number(params.winnerPoolTon);
  const loserPool = Number(params.loserPoolTon);
  const userStake = Number(params.userStakeTon);

  if (winnerPool <= 0 || userStake <= 0) {
    return "0";
  }

  const totalPool = winnerPool + loserPool;
  return ((userStake / winnerPool) * totalPool).toFixed(6);
}
