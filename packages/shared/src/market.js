export const SUPPORTED_ASSETS = ["TON", "STON", "tsTON", "UTYA", "MAJOR", "REDO"];
export const MARKET_DURATIONS = [300, 900, 1800, 3600];
export const MARKET_DIRECTIONS = ["above", "below"];
export const PROTOCOL_FEE_BPS = 200;
export const ASSET_USD_PRECISION = {
  TON: 4,
  STON: 6,
  tsTON: 6,
  UTYA: 6,
  MAJOR: 6,
  REDO: 6,
};
export const MARKET_STATUSES = [
  "OPEN",
  "LOCKED",
  "RESOLVED_YES",
  "RESOLVED_NO",
  "RESOLVED_DRAW",
];
export const POSITION_STATUSES = ["OPEN", "LOCKED", "CLAIMABLE", "CLAIMED", "LOST", "NO_POSITION"];
export const POSITION_SIDES = ["YES", "NO"];

export function formatUsd(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return "0.00";
  }

  const fixed = numeric.toFixed(6);
  const trimmed = fixed.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, ".00");
  return trimmed.includes(".") ? trimmed : `${trimmed}.00`;
}

export function getAssetUsdPrecision(asset) {
  return ASSET_USD_PRECISION[asset] ?? 6;
}

export function formatAssetUsd(value, asset) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return Number(0).toFixed(getAssetUsdPrecision(asset));
  }

  return numeric.toFixed(getAssetUsdPrecision(asset));
}

export function formatTon(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return "0";
  }

  const fixed = numeric.toFixed(3);
  return fixed.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

export function formatCountdown(secondsRemaining) {
  const safe = Math.max(0, Math.floor(Number(secondsRemaining) || 0));
  const minutes = String(Math.floor(safe / 60)).padStart(2, "0");
  const seconds = String(safe % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function formatDurationLabel(durationSec) {
  const numeric = Number(durationSec ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 min";
  }

  if (numeric % 3600 === 0) {
    return `${numeric / 3600} hour`;
  }

  return `${numeric / 60} min`;
}

export function getDirectionLabel(direction) {
  return direction === "above" ? "Above" : direction === "below" ? "Below" : "Unknown";
}

export function getMarketOutcomeLabel(outcome) {
  if (outcome === "YES") return "Yes";
  if (outcome === "NO") return "No";
  if (outcome === "DRAW") return "Refund";
  return "Pending";
}

export function deriveMarketStatus(input, nowSec = Math.floor(Date.now() / 1000)) {
  if (
    input.status === "RESOLVED_YES" ||
    input.status === "RESOLVED_NO" ||
    input.status === "RESOLVED_DRAW"
  ) {
    return input.status;
  }

  if (Number(input.resolveAt) <= nowSec) {
    return "LOCKED";
  }

  if (Number(input.closeAt) <= nowSec) {
    return "LOCKED";
  }

  return input.status;
}

export function getMarketStatusLabel(status) {
  if (status === "OPEN") return "Open";
  if (status === "LOCKED") return "Closed";
  if (status === "RESOLVED_YES") return "Resolved: Yes";
  if (status === "RESOLVED_NO") return "Resolved: No";
  if (status === "RESOLVED_DRAW") return "Resolved: Refund";
  return status;
}

export function buildMarketQuestion(input) {
  return `Will ${input.token} be ${input.direction} $${formatAssetUsd(input.threshold, input.token)} in ${formatDurationLabel(input.durationSec)}?`;
}

export function determineOutcome(input) {
  const threshold = Number(input.threshold);
  const finalPrice = Number(input.finalPrice);

  if (finalPrice === threshold) {
    return "DRAW";
  }

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
  const grossPayout = (userStake / winnerPool) * totalPool;
  const grossWinnings = Math.max(0, grossPayout - userStake);
  const protocolFee = grossWinnings * (PROTOCOL_FEE_BPS / 10_000);
  return (grossPayout - protocolFee).toFixed(6);
}

export function calculateProtocolFee(params) {
  const winnerPool = Number(params.winnerPoolTon);
  const loserPool = Number(params.loserPoolTon);
  const userStake = Number(params.userStakeTon);

  if (winnerPool <= 0 || userStake <= 0) {
    return "0";
  }

  const totalPool = winnerPool + loserPool;
  const grossPayout = (userStake / winnerPool) * totalPool;
  const grossWinnings = Math.max(0, grossPayout - userStake);
  return (grossWinnings * (PROTOCOL_FEE_BPS / 10_000)).toFixed(6);
}

export function buildMarketView(market, nowSec = Math.floor(Date.now() / 1000)) {
  const effectiveStatus = deriveMarketStatus(market, nowSec);
  const countdownTarget = effectiveStatus === "OPEN" ? market.closeAt : market.resolveAt;
  const countdownSeconds = Math.max(0, Number(countdownTarget) - nowSec);
  const isPendingChain = market.onchainReady === false;

  return {
    ...market,
    effectiveStatus,
    directionLabel: getDirectionLabel(market.direction),
    statusLabel: isPendingChain ? "Awaiting chain" : getMarketStatusLabel(effectiveStatus),
    outcomeLabel: getMarketOutcomeLabel(market.outcome),
    currentPriceLabel: `$${formatAssetUsd(market.currentPrice, market.token)}`,
    thresholdLabel: `$${formatAssetUsd(market.threshold, market.token)}`,
    finalPriceLabel: market.finalPrice == null ? "Pending" : `$${formatAssetUsd(market.finalPrice, market.token)}`,
    yesPoolLabel: `${formatTon(market.yesPool)} TON`,
    noPoolLabel: `${formatTon(market.noPool)} TON`,
    countdownSeconds,
    countdownLabel: formatCountdown(countdownSeconds),
    isPendingChain,
    question: market.question ?? buildMarketQuestion(market),
  };
}

export function derivePositionStatus(position, marketView) {
  if (!position || !marketView) {
    return "NO_POSITION";
  }

  if (position.claimed) {
    return "CLAIMED";
  }

  if (marketView.effectiveStatus === "OPEN") {
    return "OPEN";
  }

  if (marketView.effectiveStatus === "LOCKED") {
    return "LOCKED";
  }

  if (
    (marketView.outcome === "YES" && position.side === "YES") ||
    (marketView.outcome === "NO" && position.side === "NO")
  ) {
    return "CLAIMABLE";
  }

  if (marketView.outcome === "DRAW" && position.amountTon > 0) {
    return "CLAIMABLE";
  }

  return "LOST";
}

export function getPositionStatusLabel(status) {
  if (status === "CLAIMABLE") return "Claimable";
  if (status === "CLAIMED") return "Claimed";
  if (status === "LOST") return "Lost";
  if (status === "LOCKED") return "Awaiting resolve";
  if (status === "OPEN") return "Open";
  return "No position";
}

export function buildPositionView(position, marketView) {
  const isDraw = marketView.outcome === "DRAW";
  const positionStatus = derivePositionStatus(position, marketView);
  const winnerPoolTon = marketView.outcome === "YES" ? marketView.yesPool : marketView.noPool;
  const loserPoolTon = marketView.outcome === "YES" ? marketView.noPool : marketView.yesPool;
  const feeTon =
    !isDraw && (positionStatus === "CLAIMABLE" || positionStatus === "CLAIMED")
      ? calculateProtocolFee({
          winnerPoolTon,
          loserPoolTon,
          userStakeTon: position.amountTon,
        })
      : "0";
  const payoutTon =
    isDraw && (positionStatus === "CLAIMABLE" || positionStatus === "CLAIMED")
      ? Number(position.amountTon).toFixed(6)
      : positionStatus === "CLAIMABLE" || positionStatus === "CLAIMED"
      ? calculatePayout({
          winnerPoolTon,
          loserPoolTon,
          userStakeTon: position.amountTon,
        })
      : "0";

  return {
    ...position,
    marketId: marketView.id,
    token: marketView.token,
    iconUrl: marketView.iconUrl ?? null,
    question: marketView.question,
    marketStatus: marketView.effectiveStatus,
    marketStatusLabel: marketView.statusLabel,
    marketOutcome: marketView.outcome,
    marketOutcomeLabel: marketView.outcomeLabel,
    betLabel: position.side === "YES" ? "Yes" : "No",
    resultLabel: marketView.outcomeLabel,
    sideLabel:
      position.side === "YES"
        ? marketView.direction === "above"
          ? "Up"
          : "Down"
        : marketView.direction === "above"
          ? "Down"
          : "Up",
    amountLabel: `${formatTon(position.amountTon)} TON`,
    payoutTon,
    payoutLabel: payoutTon === "0" ? "0 TON" : `${formatTon(payoutTon)} TON`,
    protocolFeeTon: feeTon,
    protocolFeeLabel: feeTon === "0" ? "0 TON" : `${formatTon(feeTon)} TON`,
    positionStatus,
    positionStatusLabel: getPositionStatusLabel(positionStatus),
    claimable: positionStatus === "CLAIMABLE",
    claimed: Boolean(position.claimed),
  };
}
