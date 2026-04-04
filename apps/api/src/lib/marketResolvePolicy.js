import {
  DIRECTION_ABOVE,
  DIRECTION_BELOW,
  OUTCOME_DRAW,
  OUTCOME_NO,
  OUTCOME_YES,
  formatPrice6,
} from "./tonForecastMarket.js";

const TON_MULTI_SOURCE_MINIMUM = 2;
const DEFAULT_MAX_SPREAD_BPS = 100n;

function normalizeBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value);
}

export function deriveOutcomeFromPrice(direction, threshold, finalPrice) {
  const normalizedThreshold = normalizeBigInt(threshold);
  const normalizedFinalPrice = normalizeBigInt(finalPrice);

  if (
    (direction === DIRECTION_ABOVE && normalizedFinalPrice > normalizedThreshold) ||
    (direction === DIRECTION_BELOW && normalizedFinalPrice < normalizedThreshold)
  ) {
    return OUTCOME_YES;
  }

  if (normalizedFinalPrice === normalizedThreshold) {
    return OUTCOME_DRAW;
  }

  return OUTCOME_NO;
}

export function getMinimumSourceCount(assetIdText) {
  return assetIdText === "TON" ? TON_MULTI_SOURCE_MINIMUM : 1;
}

export function calculateSpreadBps(quotes) {
  if (!Array.isArray(quotes) || quotes.length <= 1) {
    return 0n;
  }

  const prices = quotes.map((quote) => normalizeBigInt(quote.finalPrice)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const min = prices[0];
  const max = prices[prices.length - 1];
  const midpoint = (min + max) / 2n;
  if (midpoint <= 0n) {
    return 0n;
  }

  return ((max - min) * 10_000n) / midpoint;
}

function selectDeterministicFinalPrice(quotes) {
  const prices = quotes
    .map((quote) => normalizeBigInt(quote.finalPrice))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (prices.length === 1) {
    return prices[0];
  }

  const midpoint = Math.floor(prices.length / 2);
  if (prices.length % 2 === 1) {
    return prices[midpoint];
  }

  return (prices[midpoint - 1] + prices[midpoint]) / 2n;
}

export function evaluateResolutionQuotes({
  assetIdText,
  direction,
  threshold,
  quotes,
  maxSpreadBps = DEFAULT_MAX_SPREAD_BPS,
}) {
  const normalizedQuotes = Array.isArray(quotes)
    ? quotes
        .filter((quote) => quote?.source && quote?.finalPrice != null)
        .map((quote) => ({
          source: String(quote.source),
          finalPrice: normalizeBigInt(quote.finalPrice),
          capturedAt: quote.capturedAt ?? new Date().toISOString(),
        }))
    : [];
  const minimumSourceCount = getMinimumSourceCount(assetIdText);
  const normalizedThreshold = normalizeBigInt(threshold);

  if (normalizedQuotes.length < minimumSourceCount) {
    return {
      ok: false,
      retryable: true,
      reason: `Need at least ${minimumSourceCount} independent price source(s) for ${assetIdText}, got ${normalizedQuotes.length}`,
      sourceCount: normalizedQuotes.length,
      minimumSourceCount,
      quotes: normalizedQuotes,
      spreadBps: 0n,
    };
  }

  const quoteOutcomes = normalizedQuotes.map((quote) => ({
    ...quote,
    outcome: deriveOutcomeFromPrice(direction, normalizedThreshold, quote.finalPrice),
  }));
  const uniqueOutcomes = [...new Set(quoteOutcomes.map((quote) => quote.outcome))];
  if (uniqueOutcomes.length !== 1) {
    return {
      ok: false,
      retryable: true,
      reason: `Independent price sources disagree on outcome for ${assetIdText}`,
      sourceCount: normalizedQuotes.length,
      minimumSourceCount,
      quotes: quoteOutcomes,
      spreadBps: calculateSpreadBps(quoteOutcomes),
    };
  }

  const spreadBps = calculateSpreadBps(quoteOutcomes);
  if (spreadBps > normalizeBigInt(maxSpreadBps)) {
    return {
      ok: false,
      retryable: true,
      reason: `Independent price sources exceed allowed spread (${spreadBps}bps > ${maxSpreadBps}bps)`,
      sourceCount: normalizedQuotes.length,
      minimumSourceCount,
      quotes: quoteOutcomes,
      spreadBps,
    };
  }

  const finalPrice = selectDeterministicFinalPrice(quoteOutcomes);
  const outcome = uniqueOutcomes[0];

  return {
    ok: true,
    finalPrice,
    outcome,
    sourceCount: normalizedQuotes.length,
    minimumSourceCount,
    spreadBps,
    quotes: quoteOutcomes,
    summary: quoteOutcomes.map((quote) => `${quote.source}:$${formatPrice6(quote.finalPrice)}`).join(" | "),
  };
}

export function formatResolutionQuotes(quotes = []) {
  return quotes
    .map((quote) => `${quote.source}:$${formatPrice6(quote.finalPrice)}`)
    .join(" | ");
}
