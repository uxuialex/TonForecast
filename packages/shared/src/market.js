export const SUPPORTED_ASSETS = ["TON", "STON", "tsTON", "UTYA", "MAJOR", "REDO"];
export const MARKET_DURATIONS = [300, 900, 1800, 3600];
export const MARKET_DIRECTIONS = ["above", "below"];
export const PROTOCOL_FEE_BPS = 200;
export const MARKET_STATUSES = [
  "OPEN",
  "LOCKED",
  "RESOLVED_YES",
  "RESOLVED_NO",
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
  return "Pending";
}

export function deriveMarketStatus(input, nowSec = Math.floor(Date.now() / 1000)) {
  if (input.status === "RESOLVED_YES" || input.status === "RESOLVED_NO") {
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
  return status;
}

export function buildMarketQuestion(input) {
  return `Will ${input.token} be ${input.direction} $${formatUsd(input.threshold)} in ${formatDurationLabel(input.durationSec)}?`;
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

  return {
    ...market,
    effectiveStatus,
    directionLabel: getDirectionLabel(market.direction),
    statusLabel: getMarketStatusLabel(effectiveStatus),
    outcomeLabel: getMarketOutcomeLabel(market.outcome),
    currentPriceLabel: `$${formatUsd(market.currentPrice)}`,
    thresholdLabel: `$${formatUsd(market.threshold)}`,
    finalPriceLabel: market.finalPrice == null ? "Pending" : `$${formatUsd(market.finalPrice)}`,
    yesPoolLabel: `${formatTon(market.yesPool)} TON`,
    noPoolLabel: `${formatTon(market.noPool)} TON`,
    countdownSeconds,
    countdownLabel: formatCountdown(countdownSeconds),
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

  return "LOST";
}

export function getPositionStatusLabel(status) {
  if (status === "CLAIMABLE") return "Claimable";
  if (status === "CLAIMED") return "Claimed";
  if (status === "LOST") return "Lost";
  if (status === "LOCKED") return "Closed";
  if (status === "OPEN") return "Open";
  return "No position";
}

export function buildPositionView(position, marketView) {
  const positionStatus = derivePositionStatus(position, marketView);
  const winnerPoolTon = marketView.outcome === "YES" ? marketView.yesPool : marketView.noPool;
  const loserPoolTon = marketView.outcome === "YES" ? marketView.noPool : marketView.yesPool;
  const feeTon =
    positionStatus === "CLAIMABLE" || positionStatus === "CLAIMED"
      ? calculateProtocolFee({
          winnerPoolTon,
          loserPoolTon,
          userStakeTon: position.amountTon,
        })
      : "0";
  const payoutTon =
    positionStatus === "CLAIMABLE" || positionStatus === "CLAIMED"
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
    question: marketView.question,
    marketStatus: marketView.effectiveStatus,
    marketStatusLabel: marketView.statusLabel,
    marketOutcome: marketView.outcome,
    marketOutcomeLabel: marketView.outcomeLabel,
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
