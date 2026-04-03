const tg = window.Telegram?.WebApp;
const isTelegram = !!tg;

document.documentElement.dataset.telegram = isTelegram ? "true" : "false";
document.body.classList.toggle("is-telegram", isTelegram);

if (isTelegram) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#080b16");
  tg.setBackgroundColor("#080b16");
}

const TOKEN_META = {
  TON: { color: "#0098EA" },
  STON: { color: "#0088CC" },
  tsTON: { color: "#7C3AED" },
  UTYA: { color: "#F59E0B" },
  MAJOR: { color: "#2563EB" },
  REDO: { color: "#10B981" },
};

const ASSET_ICON_VERSION = "20260404b";
const CREATE_ASSET_OPTIONS = ["TON", "STON", "tsTON", "UTYA", "MAJOR", "REDO"];

const MARKET_FILTER_OPTIONS = [
  { value: "OPEN", label: "Active" },
  { value: "", label: "All" },
  { value: "LOCKED", label: "Closed" },
  { value: "RESOLVED", label: "Resolved" },
];

function getTokenIconUrl(symbol) {
  return `/api/assets/icons/${encodeURIComponent(symbol)}?v=${ASSET_ICON_VERSION}`;
}

function tokenIconHtml(symbol, iconUrl = getTokenIconUrl(symbol), variant = "default") {
  const meta = TOKEN_META[symbol] || {};
  const color = meta.color || "#6366f1";
  const iconClass = variant === "badge" ? "token-icon token-icon--badge" : "token-icon";
  const fallbackClass =
    variant === "badge"
      ? "token-icon token-icon--letter token-icon--badge-letter"
      : "token-icon token-icon--letter";
  const letter = `<span class="${fallbackClass}" style="background:${color}">${symbol[0]}</span>`;
  if (!iconUrl) return letter;
  return (
    `<img class="${iconClass}" src="${iconUrl}" alt="${symbol}" ` +
    `onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />` +
    `<span class="${fallbackClass}" style="display:none;background:${color}">${symbol[0]}</span>`
  );
}

function assetBadgeHtml(symbol, iconUrl) {
  return `<span class="asset-badge ${getAssetTone(symbol)}">${tokenIconHtml(symbol, iconUrl, "badge")}<span>${symbol}</span></span>`;
}

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const assetEl = document.querySelector("#asset");
const assetPickerEl = document.querySelector("#asset-picker");
const assetPickerTriggerEl = document.querySelector("#asset-picker-trigger");
const assetPickerValueEl = document.querySelector("#asset-picker-value");
const assetPickerMenuEl = document.querySelector("#asset-picker-menu");
const assetPickerOptionEls = Array.from(
  document.querySelectorAll(".asset-picker__option"),
);
const durationEl = document.querySelector("#duration");
const previewQuestionEl = document.querySelector("#preview-question");
const walletStatusEl = document.querySelector("#wallet-status");
const walletAddressEl = document.querySelector("#wallet-address");
const marketGridEl = document.querySelector("#market-grid");
const marketFeedbackEl = document.querySelector("#markets-feedback");
const positionsFeedbackEl = document.querySelector("#positions-feedback");
const positionsListEl = document.querySelector("#positions-list");
const marketFilterEl = document.querySelector("#market-filter");
const marketFilterTriggerEl = document.querySelector("#market-filter-trigger");
const marketFilterLabelEl = document.querySelector("#market-filter-label");
const marketFilterMenuEl = document.querySelector("#market-filter-menu");
const marketFilterOptionEls = Array.from(
  document.querySelectorAll(".market-filter__option"),
);
const priceStripEl = document.querySelector("#price-strip");
const createCurrentPriceEl = document.querySelector("#create-current-price");
const createNoticeEl = document.querySelector("#create-notice");
const createMarketButtonEl = document.querySelector("#create-market-button");
const actionFeedbackEl = document.querySelector("#action-feedback");
const runtimeModeEl = document.querySelector("#runtime-mode");

const manifestUrl = `${window.location.origin}/tonconnect-manifest.json`;
const TWA_RETURN_URL = "https://t.me/chatchatgpt_bot/TON_Forecast";

const state = {
  activePanel: "markets",
  activeMarketStatus: "OPEN",
  wallet: null,
  tonConnectUI: null,
  isTelegram,
  markets: [],
  positions: [],
  prices: [],
  createContext: {
    asset: assetEl.value,
    durationSec: Number(durationEl.value),
    currentPrice: null,
    currentPriceLabel: "",
    thresholdLabel: "",
    question: "",
    canCreate: false,
    blockedReason: "",
  },
  createContextLoaded: false,
  positionsLoaded: false,
  positionsLoading: false,
  pendingCreateAddress: null,
  createSubmitting: false,
  pendingBet: null,
  pendingClaim: null,
  marketsLoading: false,
  createNotice: null,
  marketNotices: {},
  positionNotices: {},
};

let panelTransitionInFlight = false;

if (runtimeModeEl) {
  runtimeModeEl.textContent = isTelegram ? "Inside Telegram" : "Browser Preview";
}

function syncPriceStripVisibility(activePanelName) {
  if (!priceStripEl) {
    return;
  }

  priceStripEl.classList.toggle("is-hidden", activePanelName !== "markets");
}

function getActivePanelName() {
  return state.activePanel;
}

function switchPanel(nextPanelName) {
  const currentPanel = document.querySelector(".panel.is-active");
  const nextPanel = document.querySelector(`.panel[data-panel="${nextPanelName}"]`);

  if (!nextPanel || currentPanel === nextPanel || panelTransitionInFlight) {
    return;
  }

  panelTransitionInFlight = true;
  state.activePanel = nextPanelName;
  syncPriceStripVisibility(nextPanelName);
  tabs.forEach((item) => item.classList.toggle("is-active", item.dataset.tab === nextPanelName));

  nextPanel.classList.add("is-active", "is-entering");
  requestAnimationFrame(() => {
    nextPanel.classList.add("is-visible");
  });

  if (currentPanel) {
    currentPanel.classList.add("is-leaving");
    currentPanel.classList.remove("is-visible");
  }

  window.setTimeout(() => {
    if (currentPanel) {
      currentPanel.classList.remove("is-active", "is-leaving", "is-visible");
    }
    nextPanel.classList.remove("is-entering");
    nextPanel.classList.add("is-visible");
    panelTransitionInFlight = false;
  }, 260);

  if (nextPanelName === "create" && !state.createContextLoaded) {
    loadCreateContext();
  }

  if (nextPanelName === "profile" && state.wallet && !state.positionsLoaded) {
    loadPositions();
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    switchPanel(tab.dataset.tab);
  });
});

document.querySelector(".panel.is-active")?.classList.add("is-visible");
syncPriceStripVisibility(document.querySelector(".panel.is-active")?.dataset.panel ?? "markets");

function shortAddress(value) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function setActionFeedback(message) {
  if (!actionFeedbackEl) {
    return;
  }

  actionFeedbackEl.textContent = message;
  actionFeedbackEl.classList.remove("is-hidden");
}

function clearActionFeedback() {
  if (!actionFeedbackEl) {
    return;
  }

  actionFeedbackEl.textContent = "";
  actionFeedbackEl.classList.add("is-hidden");
}

function renderInlineNotice(element, notice) {
  if (!element) {
    return;
  }

  element.classList.remove(
    "is-hidden",
    "inline-notice--info",
    "inline-notice--success",
    "inline-notice--warn",
    "inline-notice--error",
    "inline-notice--muted",
  );

  if (!notice?.message) {
    element.textContent = "";
    element.classList.add("is-hidden");
    return;
  }

  const type = notice.type || "info";
  element.textContent = notice.message;
  element.classList.add(`inline-notice--${type}`);
}

function setCreateNotice(message, type = "info") {
  state.createNotice = message ? { message, type } : null;
  renderInlineNotice(createNoticeEl, state.createNotice);
}

function setMarketNotice(contractAddress, message, type = "info") {
  if (!contractAddress) {
    return;
  }

  if (!message) {
    delete state.marketNotices[contractAddress];
  } else {
    state.marketNotices[contractAddress] = { message, type };
  }

  renderMarkets(state.markets);
}

function setPositionNotice(positionId, message, type = "info") {
  if (!positionId) {
    return;
  }

  if (!message) {
    delete state.positionNotices[positionId];
  } else {
    state.positionNotices[positionId] = { message, type };
  }

  renderPositions(state.positions);
}

function normalizeActionError(message) {
  if (!message) {
    return "Unexpected error";
  }

  const normalized = String(message)
    .replace(/^Create failed:\s*/i, "")
    .replace(/^Bet failed:\s*/i, "")
    .replace(/^Bet blocked:\s*/i, "")
    .replace(/^Claim failed:\s*/i, "")
    .replace(/^Claim blocked:\s*/i, "")
    .trim();

  if (/429|too many requests|rate limit/i.test(normalized)) {
    return "Network is busy right now. Retry in a few seconds.";
  }

  if (/timed out|fetch failed|network/i.test(normalized)) {
    return "Network is slow right now. Retry in a few seconds.";
  }

  return normalized;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildAssetPickerItemHtml(asset) {
  return `
    <span class="asset-picker__item">
      ${tokenIconHtml(asset)}
      <span class="asset-picker__label">${asset}</span>
    </span>
  `;
}

async function promptWalletConnection(contextLabel = "this action") {
  if (!state.tonConnectUI?.openModal) {
    throw new Error(`Connect a wallet first to use ${contextLabel}.`);
  }

  try {
    await state.tonConnectUI.openModal();
  } catch (error) {
    throw new Error(
      `Wallet connection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getMarketFilterLabel(value) {
  return (
    MARKET_FILTER_OPTIONS.find((option) => option.value === value)?.label ??
    "Active"
  );
}

function formatDurationLabel(durationSec) {
  const numeric = Number(durationSec ?? 0);
  if (numeric % 3600 === 0) {
    return `${numeric / 3600} hour`;
  }
  return `${numeric / 60} min`;
}

function formatCountdown(timestampSec) {
  const diff = Math.max(0, timestampSec - Math.floor(Date.now() / 1000));
  const minutes = String(Math.floor(diff / 60)).padStart(2, "0");
  const seconds = String(diff % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function deriveEffectiveStatus(market) {
  if (
    market.effectiveStatus === "RESOLVED_YES" ||
    market.effectiveStatus === "RESOLVED_NO"
  ) {
    return market.effectiveStatus;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (market.resolveAt <= nowSec || market.closeAt <= nowSec) {
    return "LOCKED";
  }

  return market.effectiveStatus ?? market.status;
}

function getAssetTone(token) {
  if (token === "TON") return "tone-blue";
  if (token === "STON" || token === "MAJOR") return "tone-orange";
  return "tone-green";
}

function getStatusClass(status) {
  if (status === "LOCKED") return "status-pill is-locking";
  if (status === "RESOLVED_YES") return "status-pill is-resolved-yes";
  if (status === "RESOLVED_NO") return "status-pill is-resolved-no";
  if (status === "RESOLVED_DRAW") return "status-pill is-resolved-draw";
  return "status-pill";
}

function getDisplayStatusClass(market, status) {
  if (market.isPendingChain) return "status-pill is-pending-chain";
  return getStatusClass(status);
}

function getClaimClass(status) {
  if (status === "CLAIMABLE") return "claim-pill is-claimable";
  if (status === "CLAIMED") return "claim-pill is-claimed";
  if (status === "LOCKED") return "claim-pill is-locking";
  if (status === "LOST") return "claim-pill is-lost";
  return "claim-pill is-open";
}

function getClaimButtonLabel(position) {
  if (state.pendingClaim?.positionId === position.id) return "Confirming...";
  if (position.claimable) return "Claim";
  if (position.claimed) return "Claimed";
  if (position.positionStatus === "LOCKED") return "Awaiting resolve";
  if (position.positionStatus === "LOST") return "Lost";
  if (position.positionStatus === "OPEN") return "Open";
  return "Claim";
}

function getCreateButtonLabel() {
  if (state.createSubmitting) {
    return "Submitting...";
  }
  if (state.pendingCreateAddress) {
    return "Awaiting chain...";
  }
  return "Create Market";
}

function getExplorerUrl(address) {
  return `https://tonviewer.com/${encodeURIComponent(address)}`;
}

function getMarketActionHint(market, effectiveStatus) {
  const pendingBet = state.pendingBet?.contractAddress === market.contractAddress;
  if (pendingBet) {
    return `Bet submitted. Waiting for blockchain confirmation and pool refresh.`;
  }
  if (market.isPendingChain) {
    return "Waiting for blockchain confirmation before the first bet.";
  }
  if (effectiveStatus === "LOCKED") {
    return "Betting is closed. Auto-resolve should settle this market next.";
  }
  if (effectiveStatus.startsWith("RESOLVED")) {
    return "Settlement is final. Claim from My Positions on the winning side.";
  }
  return "";
}

function getOutcomeLabel(outcome) {
  if (outcome === "YES") return "Yes";
  if (outcome === "NO") return "No";
  if (outcome === "DRAW") return "Refund";
  return "Pending";
}

function syncWalletState(wallet) {
  state.wallet = wallet;

  if (!wallet) {
    state.pendingBet = null;
    state.pendingClaim = null;
    state.positionsLoaded = false;
    state.positionsLoading = false;
    walletStatusEl.textContent = "Wallet not connected";
    walletAddressEl.textContent =
      "Connect a TON wallet to create markets, place bets, and claim payouts.";
    positionsFeedbackEl.textContent = "Connect a wallet to load positions.";
    positionsFeedbackEl.classList.remove("is-loading");
    positionsListEl.innerHTML =
      '<div class="position-empty">Wallet disconnected. Position feed is idle.</div>';
    renderMarkets(state.markets);
    renderPositions(state.positions);
    setCreateNotice("Connect a wallet to unlock create, bet, and claim actions.", "info");
    syncCreateButtonState();
    return;
  }

  walletStatusEl.textContent = "Wallet connected";
  walletAddressEl.textContent = `${shortAddress(wallet.account.address)} • Create, bet and claim with this wallet.`;
  clearActionFeedback();
  if (state.createNotice?.message?.startsWith("Connect a wallet")) {
    setCreateNotice(null);
  }
  if (getActivePanelName() === "profile") {
    loadPositions();
  }
  if (getActivePanelName() === "create") {
    loadCreateContext();
  }
  renderMarkets(state.markets);
  syncCreateButtonState();
}

function buildBetButtonLabel(market, side) {
  return side === "YES" ? "Yes" : "No";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function renderPrices(items) {
  if (!items.length) {
    priceStripEl.innerHTML =
      '<div class="ticker-pill is-loading">Failed to load live prices.</div>';
    return;
  }

  priceStripEl.innerHTML = items
    .map(
      (item) => `
        <div class="ticker-pill">
          ${tokenIconHtml(item.asset, item.iconUrl)}
          <div class="ticker-info">
            <span class="ticker-sym">${item.asset}</span>
            <span class="ticker-price">$${item.priceUsd}</span>
          </div>
        </div>
      `,
    )
    .join("");
}

function renderMarketSkeletons(count = 3) {
  marketGridEl.innerHTML = Array.from({ length: count }, () => `
    <article class="market-card market-card--skeleton" aria-hidden="true">
      <div class="market-topline">
        <div class="skeleton-pill"></div>
        <div class="skeleton-badge"></div>
      </div>
      <div class="skeleton-line skeleton-line--title"></div>
      <div class="market-stats">
        <div><dt>Loading</dt><dd><span class="skeleton-line"></span></dd></div>
        <div><dt>Loading</dt><dd><span class="skeleton-line"></span></dd></div>
        <div><dt>Loading</dt><dd><span class="skeleton-line"></span></dd></div>
        <div><dt>Loading</dt><dd><span class="skeleton-line"></span></dd></div>
        <div><dt>Loading</dt><dd><span class="skeleton-line"></span></dd></div>
        <div><dt>Loading</dt><dd><span class="skeleton-line"></span></dd></div>
        <div><dt>Loading</dt><dd><span class="skeleton-line"></span></dd></div>
        <div><dt>Loading</dt><dd><span class="skeleton-line"></span></dd></div>
      </div>
      <div class="card-actions">
        <div class="skeleton-button"></div>
        <div class="skeleton-button"></div>
      </div>
    </article>
  `).join("");
}

function renderPositionSkeletons(count = 2) {
  positionsListEl.innerHTML = Array.from({ length: count }, () => `
    <article class="position-row position-row--skeleton" aria-hidden="true">
      <div>
        <div class="position-header">
          <div class="skeleton-line skeleton-line--position-title"></div>
          <div class="skeleton-link"></div>
        </div>
        <div class="position-facts">
          <span class="skeleton-line skeleton-line--position-meta"></span>
          <span class="skeleton-line skeleton-line--position-meta"></span>
          <span class="skeleton-line skeleton-line--position-meta"></span>
          <span class="skeleton-line skeleton-line--position-meta"></span>
        </div>
      </div>
      <div class="skeleton-pill skeleton-pill--position"></div>
      <div class="skeleton-button skeleton-button--position"></div>
    </article>
  `).join("");
}

function syncPreview() {
  const asset = assetEl.value;
  const duration = durationEl.value;
  const currentPriceText = state.createContext.currentPriceLabel
    ? `Current price: ${state.createContext.currentPriceLabel}`
    : "Current price: loading...";

  previewQuestionEl.textContent =
    state.createContext.question ||
    `Will ${asset} be above live market price in ${formatDurationLabel(duration)}?`;
  createCurrentPriceEl.textContent = state.createContext.blockedReason
    ? `${currentPriceText} • ${state.createContext.blockedReason}`
    : `${currentPriceText} • Fixed on signature. Price source: CMC for TON, STON.fi for ecosystem tokens.`;

  renderInlineNotice(createNoticeEl, state.createNotice);
}

function syncCreateButtonState() {
  createMarketButtonEl.disabled =
    !state.wallet ||
    !state.createContext.canCreate ||
    state.createSubmitting ||
    Boolean(state.pendingCreateAddress);
  createMarketButtonEl.textContent = getCreateButtonLabel();
}

async function loadPrices() {
  try {
    const payload = await requestJson("/api/prices");
    state.prices = payload.items ?? [];
    renderPrices(state.prices);
  } catch (error) {
    priceStripEl.innerHTML = `<div class="ticker-pill is-loading">Prices unavailable: ${error.message}</div>`;
  }
}

function buildMarketStatusMeta(market) {
  const effectiveStatus = deriveEffectiveStatus(market);
  const nowSec = Math.floor(Date.now() / 1000);

  if (effectiveStatus === "OPEN") {
    return {
      statusText: "Closes in",
      statusValue: formatCountdown(market.closeAt),
    };
  }

  if (effectiveStatus === "LOCKED") {
    if (market.resolveAt > nowSec) {
      return {
        statusText: "Auto-resolve in",
        statusValue: formatCountdown(market.resolveAt),
      };
    }

    return {
      statusText: "Resolve due",
      statusValue: new Date(market.resolveAt * 1000).toLocaleTimeString(),
    };
  }

  return {
    statusText: "Outcome",
    statusValue: getOutcomeLabel(market.outcome),
  };
}

function renderMarkets(items) {
  if (!items.length) {
    marketGridEl.innerHTML = "";
    marketFeedbackEl.textContent = "No markets for the selected status.";
    return;
  }

  marketFeedbackEl.textContent = `${items.length} market${items.length > 1 ? "s" : ""}`;
  marketGridEl.innerHTML = items
    .map((market) => {
      const effectiveStatus = deriveEffectiveStatus(market);
      const statusMeta = buildMarketStatusMeta(market);
      const isPendingBet = state.pendingBet?.contractAddress === market.contractAddress;
      const pendingBetSide = isPendingBet ? state.pendingBet.side : null;
      const canBet =
        state.wallet &&
        effectiveStatus === "OPEN" &&
        market.onchainReady !== false &&
        !isPendingBet &&
        !market.isPendingChain;
      const actionHint = getMarketActionHint(market, effectiveStatus);
      const notice = state.marketNotices[market.contractAddress] ?? null;
      const isPendingCreate = state.pendingCreateAddress === market.contractAddress;

      return `
        <article class="market-card ${isPendingCreate ? "is-pending-market" : ""}" data-market-address="${market.contractAddress}">
          <div class="market-topline">
            ${assetBadgeHtml(market.token, market.iconUrl)}
            <div class="market-topline__meta">
              <span class="${getDisplayStatusClass(market, effectiveStatus)}">${market.statusLabel}</span>
              <a
                class="market-link"
                href="${getExplorerUrl(market.contractAddress)}"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open market on explorer"
                title="Open on explorer"
              >↗</a>
            </div>
          </div>
          <h3>${market.question}</h3>
          <dl class="market-stats">
            <div><dt>Current</dt><dd>${market.currentPriceLabel}</dd></div>
            <div><dt>Duration</dt><dd>${formatDurationLabel(market.durationSec)}</dd></div>
            <div><dt>${statusMeta.statusText}</dt><dd>${statusMeta.statusValue}</dd></div>
            <div><dt>Close</dt><dd>${new Date(market.closeAt * 1000).toLocaleTimeString()}</dd></div>
            <div><dt>Up pool</dt><dd>${market.yesPoolLabel}</dd></div>
            <div><dt>Down pool</dt><dd>${market.noPoolLabel}</dd></div>
            <div><dt>Result</dt><dd>${market.outcomeLabel}</dd></div>
            <div><dt>Final price</dt><dd>${market.finalPriceLabel}</dd></div>
            <div><dt>Resolve</dt><dd>${new Date(market.resolveAt * 1000).toLocaleTimeString()}</dd></div>
          </dl>
          <div class="card-actions">
            <button class="yes-button ${pendingBetSide === "YES" ? "is-busy" : ""}" data-action="bet" data-side="YES" ${canBet ? "" : "disabled"}>${pendingBetSide === "YES" ? "Confirming..." : buildBetButtonLabel(market, "YES")}</button>
            <button class="no-button ${pendingBetSide === "NO" ? "is-busy" : ""}" data-action="bet" data-side="NO" ${canBet ? "" : "disabled"}>${pendingBetSide === "NO" ? "Confirming..." : buildBetButtonLabel(market, "NO")}</button>
          </div>
          ${
            notice
              ? `<p class="market-note inline-notice inline-notice--${notice.type}">${notice.message}</p>`
              : actionHint
                ? `<p class="market-note inline-notice inline-notice--muted">${actionHint}</p>`
                : ""
          }
        </article>
      `;
    })
    .join("");
}

async function loadMarkets(status = "") {
  state.marketsLoading = true;
  marketFeedbackEl.textContent = "Loading markets...";
  if (!state.markets.length) {
    renderMarketSkeletons();
  }

  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const payload = await requestJson(`/api/markets${query}`);
    state.markets = payload.items ?? [];
    state.marketsLoading = false;
    renderMarkets(state.markets);
  } catch (error) {
    state.marketsLoading = false;
    state.markets = [];
    marketGridEl.innerHTML = "";
    marketFeedbackEl.textContent = `Failed to load markets: ${error.message}`;
  }
}

function renderPositions(items) {
  if (!state.wallet) {
    return;
  }

  if (state.positionsLoading && !items.length) {
    renderPositionSkeletons();
    return;
  }

  if (!items.length) {
    positionsListEl.innerHTML =
      '<div class="position-empty">No positions yet. Create a market or place a bet to start the demo flow.</div>';
    return;
  }

  positionsListEl.innerHTML = items
    .map(
      (position) => `
        <article class="position-row" data-position-id="${position.id}" data-market-id="${position.marketId}">
          <div>
            <div class="position-header">
              <p class="position-title">${position.question}</p>
              <a
                class="market-link position-link"
                href="${getExplorerUrl(position.contractAddress)}"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open position market on explorer"
                title="Open on explorer"
              >↗</a>
            </div>
            <div class="position-facts">
              <p class="position-meta">Your bet: ${position.betLabel}</p>
              <p class="position-meta">Result: ${position.resultLabel}</p>
              <p class="position-meta">Stake: ${position.amountLabel}</p>
              <p class="position-meta">Pool: ${position.totalPoolLabel}</p>
              ${
                (position.claimable || position.claimed) && position.marketOutcome !== "DRAW"
                  ? `<p class="position-meta">Your share: ${position.shareLabel}</p>`
                  : ""
              }
              ${
                Number(position.protocolFeeTon ?? 0) > 0
                  ? `<p class="position-meta">Fee: ${position.protocolFeeLabel}</p>`
                  : ""
              }
              ${(position.claimable || position.claimed) ? `<p class="position-meta">Expected payout: ${position.payoutLabel}</p>` : ""}
              <p class="position-meta">State: ${position.marketStatusLabel}</p>
              <p class="position-meta">Created: ${position.createdAt ? new Date(position.createdAt * 1000).toLocaleString() : "n/a"}</p>
              <p class="position-meta">Closed: ${position.closeAt ? new Date(position.closeAt * 1000).toLocaleString() : "n/a"}</p>
            </div>
          </div>
          <span class="claim-pill ${getClaimClass(position.positionStatus)}">${position.positionStatusLabel}</span>
          <button
            class="primary-button compact-button ${state.pendingClaim?.positionId === position.id ? "is-busy" : ""}"
            data-action="claim"
            ${(position.claimable && state.wallet && state.pendingClaim?.positionId !== position.id) ? "" : "disabled"}
          >
            ${getClaimButtonLabel(position)}
          </button>
          ${
            state.positionNotices[position.id]
              ? `<p class="position-note inline-notice inline-notice--${state.positionNotices[position.id].type}">${state.positionNotices[position.id].message}</p>`
              : ""
          }
        </article>
      `,
    )
    .join("");
}

async function loadPositions() {
  if (!state.wallet) {
    state.positionsLoaded = false;
    state.positionsLoading = false;
    return;
  }

  if (state.positionsLoading) {
    return;
  }

  state.positionsLoading = true;
  positionsFeedbackEl.textContent = state.positions.length
    ? "Refreshing positions..."
    : "Loading positions...";
  positionsFeedbackEl.classList.add("is-loading");
  if (!state.positions.length) {
    renderPositionSkeletons();
  }

  try {
    const userAddress = encodeURIComponent(state.wallet.account.address);
    const payload = await requestJson(`/api/positions?userAddress=${userAddress}`);
    state.positions = payload.items ?? [];
    state.positionsLoaded = true;
    state.positionsLoading = false;
    positionsFeedbackEl.classList.remove("is-loading");
    positionsFeedbackEl.textContent = state.positions.length
      ? `${state.positions.length} tracked position${state.positions.length === 1 ? "" : "s"}`
      : "No positions yet.";
    renderPositions(state.positions);
  } catch (error) {
    state.positionsLoaded = false;
    state.positionsLoading = false;
    positionsFeedbackEl.classList.remove("is-loading");
    positionsFeedbackEl.textContent = state.positions.length
      ? `Couldn't refresh positions right now. Showing last known state.`
      : `Failed to load positions: ${error.message}`;
    if (!state.positions.length) {
      positionsListEl.innerHTML = "";
    } else {
      renderPositions(state.positions);
    }
  }
}

async function loadCreateContext() {
  try {
    const asset = assetEl.value;
    const durationSec = durationEl.value;
    const payload = await requestJson(
      `/api/create-context?asset=${encodeURIComponent(asset)}&durationSec=${encodeURIComponent(durationSec)}`,
    );

    state.createContext = {
      asset,
      durationSec: Number(durationSec),
      currentPrice: payload.currentPrice ?? null,
      currentPriceLabel: payload.currentPriceLabel ?? "",
      thresholdLabel: payload.thresholdLabel ?? "",
      question: payload.question ?? "",
      canCreate: Boolean(payload.canCreate),
      blockedReason: payload.blockedReason ?? "",
    };
    state.createContextLoaded = true;
  } catch (error) {
    state.createContext = {
      asset: assetEl.value,
      durationSec: Number(durationEl.value),
      currentPrice: null,
      currentPriceLabel: "",
      thresholdLabel: "",
      question: "",
      canCreate: false,
      blockedReason: error.message,
    };
    state.createContextLoaded = false;
    createCurrentPriceEl.textContent = `Current price unavailable: ${error.message}`;
  }

  syncCreateButtonState();
  syncPreview();
}

async function sendTonTransaction(intent) {
  if (!state.tonConnectUI) {
    throw new Error("TON Connect is not ready");
  }

  return state.tonConnectUI.sendTransaction({
    validUntil: intent.validUntil,
    messages: [intent.message],
  });
}

async function handleCreateIntent() {
  if (!state.wallet) {
    try {
      setCreateNotice("Connect a wallet to create a market.", "info");
      await promptWalletConnection("market creation");
    } catch (error) {
      setCreateNotice(normalizeActionError(error.message), "error");
    }
    return;
  }

  if (!state.createContext.canCreate) {
    setCreateNotice(
      state.createContext.blockedReason || "Create blocked for this asset and duration.",
      "warn",
    );
    return;
  }

  try {
    state.createSubmitting = true;
    syncCreateButtonState();
    setCreateNotice("Preparing create transaction...", "info");
    const intent = await requestJson("/api/actions/create-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerAddress: state.wallet.account.address,
        asset: assetEl.value,
        durationSec: Number(durationEl.value),
      }),
    });

    setCreateNotice(`Sign create for ${intent.draft.question}`, "info");
    await sendTonTransaction(intent);
    state.createSubmitting = false;
    state.pendingCreateAddress = intent.draft.contractAddress;
    syncCreateButtonState();
    await requestJson("/api/actions/create-confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractAddress: intent.draft.contractAddress,
      }),
    });

    setCreateNotice(null);
    setMarketNotice(
      intent.draft.contractAddress,
      "Market submitted. Waiting for blockchain confirmation before betting unlocks.",
      "info",
    );
    await Promise.all([loadMarkets(state.activeMarketStatus), loadCreateContext()]);
    switchPanel("markets");
    waitForMarketReady(intent.draft.contractAddress).catch((error) => {
      console.warn("waitForMarketReady failed", error);
    });
  } catch (error) {
    state.createSubmitting = false;
    state.pendingCreateAddress = null;
    syncCreateButtonState();
    setCreateNotice(normalizeActionError(error.message), "error");
  }
}

async function waitForMarketReady(contractAddress) {
  const deadlineMs = Date.now() + 45_000;
  while (Date.now() < deadlineMs) {
    try {
      const market = await requestJson(`/api/markets/${encodeURIComponent(contractAddress)}`);
      if (market.onchainReady !== false) {
        state.pendingCreateAddress = null;
        syncCreateButtonState();
        await loadMarkets(state.activeMarketStatus);
        setMarketNotice(contractAddress, "Market confirmed onchain. Betting is now unlocked.", "success");
        return;
      }
    } catch {
      // Keep polling until the contract is readable or timeout is reached.
    }

    setMarketNotice(contractAddress, "Waiting for blockchain confirmation before the first bet...", "info");
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
  }

  await loadMarkets(state.activeMarketStatus);
  state.pendingCreateAddress = null;
  syncCreateButtonState();
  setMarketNotice(
    contractAddress,
    "Market is still waiting for blockchain confirmation. Betting will unlock automatically once the contract becomes readable.",
    "warn",
  );
}

async function waitForBetIndexed(contractAddress, userAddress, previousAmountTon = 0, timeoutMs = 45_000) {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    try {
      const positionsPayload = await requestJson(`/api/positions?userAddress=${encodeURIComponent(userAddress)}&fresh=1`);
      const nextPosition = (positionsPayload.items ?? []).find((item) => item.contractAddress === contractAddress);
      if (nextPosition && Number(nextPosition.amountTon ?? 0) > previousAmountTon) {
        state.pendingBet = null;
        await Promise.all([loadMarkets(state.activeMarketStatus), loadPositions()]);
        setMarketNotice(contractAddress, "Bet confirmed onchain.", "success");
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(2500);
  }

  state.pendingBet = null;
  await Promise.all([loadMarkets(state.activeMarketStatus), loadPositions()]);
  setMarketNotice(contractAddress, "Bet sent. Position refresh may lag briefly while blockchain state propagates.", "warn");
}

async function handleBetIntent(contractAddress, side) {
  const market = state.markets.find((item) => item.contractAddress === contractAddress);
  if (!market) {
    return;
  }

  if (!state.wallet) {
    setMarketNotice(contractAddress, "Connect a wallet to place a bet.", "info");
    try {
      await promptWalletConnection("betting");
    } catch (error) {
      setMarketNotice(contractAddress, normalizeActionError(error.message), "error");
    }
    return;
  }

  if (deriveEffectiveStatus(market) !== "OPEN") {
    setMarketNotice(contractAddress, `${market.statusLabel}. Wait for the next open market.`, "warn");
    return;
  }

  const amountTon = window.prompt("Bet amount in TON", "0.01");
  if (!amountTon) {
    return;
  }

  try {
    const existingPosition = state.positions.find((item) => item.contractAddress === contractAddress);
    const previousAmountTon = Number(existingPosition?.amountTon ?? 0);
    setMarketNotice(contractAddress, `Preparing ${side === "YES" ? "Yes" : "No"} bet...`, "info");
    const intent = await requestJson("/api/actions/bet-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractAddress,
        userAddress: state.wallet.account.address,
        side,
        amountTon,
      }),
    });

    state.pendingBet = { contractAddress, side };
    renderMarkets(state.markets);
    await sendTonTransaction(intent);
    setMarketNotice(
      contractAddress,
      `${side === "YES" ? "Yes" : "No"} bet sent. Waiting for blockchain confirmation...`,
      "info",
    );
    waitForBetIndexed(contractAddress, state.wallet.account.address, previousAmountTon).catch((error) => {
      console.warn("waitForBetIndexed failed", error);
    });
  } catch (error) {
    state.pendingBet = null;
    renderMarkets(state.markets);
    setMarketNotice(contractAddress, normalizeActionError(error.message), "error");
  }
}

async function waitForClaimIndexed(positionId, userAddress, timeoutMs = 45_000) {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    try {
      const positionsPayload = await requestJson(`/api/positions?userAddress=${encodeURIComponent(userAddress)}&fresh=1`);
      const nextPosition = (positionsPayload.items ?? []).find((item) => item.id === positionId);
      if (nextPosition?.claimed) {
        state.pendingClaim = null;
        await Promise.all([loadMarkets(state.activeMarketStatus), loadPositions()]);
        setPositionNotice(positionId, "Claim confirmed onchain.", "success");
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(2500);
  }

  state.pendingClaim = null;
  await Promise.all([loadMarkets(state.activeMarketStatus), loadPositions()]);
  setPositionNotice(positionId, "Claim sent. Wallet balance and position state may update with a short onchain delay.", "warn");
}

async function handleClaimIntent(positionId) {
  const position = state.positions.find((item) => item.id === positionId);
  if (!position) {
    return;
  }

  if (!state.wallet) {
    setPositionNotice(positionId, "Connect a wallet to claim winnings.", "info");
    try {
      await promptWalletConnection("claim");
    } catch (error) {
      setPositionNotice(positionId, normalizeActionError(error.message), "error");
    }
    return;
  }

  if (!position.claimable) {
    setPositionNotice(
      positionId,
      position.positionStatus === "LOCKED"
        ? "Claim unavailable: market is closed for bets and waiting for auto-resolve."
        : `Claim unavailable: ${position.positionStatusLabel}.`,
      "warn",
    );
    return;
  }

  try {
    state.pendingClaim = { positionId, contractAddress: position.contractAddress };
    renderPositions(state.positions);
    setPositionNotice(positionId, `Preparing claim for ${position.question}...`, "info");
    const intent = await requestJson("/api/actions/claim-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractAddress: position.contractAddress,
        userAddress: state.wallet.account.address,
      }),
    });

    await sendTonTransaction(intent);
    setPositionNotice(positionId, "Claim sent. Waiting for blockchain confirmation...", "info");
    waitForClaimIndexed(positionId, state.wallet.account.address).catch((error) => {
      console.warn("waitForClaimIndexed failed", error);
    });
  } catch (error) {
    state.pendingClaim = null;
    renderPositions(state.positions);
    setPositionNotice(positionId, normalizeActionError(error.message), "error");
  }
}

function closeMarketFilter() {
  if (!marketFilterEl || !marketFilterTriggerEl || !marketFilterMenuEl) {
    return;
  }

  marketFilterEl.classList.remove("is-open");
  marketFilterMenuEl.classList.remove("is-visible");
  marketFilterTriggerEl.setAttribute("aria-expanded", "false");
  window.setTimeout(() => {
    if (!marketFilterEl.classList.contains("is-open")) {
      marketFilterMenuEl.hidden = true;
    }
  }, 180);
}

function closeAssetPicker() {
  if (!assetPickerEl || !assetPickerTriggerEl || !assetPickerMenuEl) {
    return;
  }

  assetPickerEl.classList.remove("is-open");
  assetPickerMenuEl.classList.remove("is-visible");
  assetPickerTriggerEl.setAttribute("aria-expanded", "false");
  window.setTimeout(() => {
    if (!assetPickerEl.classList.contains("is-open")) {
      assetPickerMenuEl.hidden = true;
    }
  }, 180);
}

function syncMarketFilterUi() {
  if (!marketFilterLabelEl) {
    return;
  }

  marketFilterLabelEl.textContent = getMarketFilterLabel(state.activeMarketStatus);
  marketFilterOptionEls.forEach((option) => {
    option.classList.toggle(
      "is-selected",
      option.dataset.filterValue === state.activeMarketStatus,
    );
  });
}

function syncAssetPickerUi() {
  if (!assetPickerValueEl) {
    return;
  }

  const selectedAsset = assetEl.value || CREATE_ASSET_OPTIONS[0];
  assetPickerValueEl.innerHTML = buildAssetPickerItemHtml(selectedAsset);
  assetPickerOptionEls.forEach((option) => {
    const asset = option.dataset.assetValue;
    option.innerHTML = buildAssetPickerItemHtml(asset);
    option.classList.toggle("is-selected", asset === selectedAsset);
  });
}

if (marketFilterTriggerEl && marketFilterMenuEl) {
  syncMarketFilterUi();

  marketFilterTriggerEl.addEventListener("click", () => {
    const nextOpen = !marketFilterEl.classList.contains("is-open");
    marketFilterEl.classList.toggle("is-open", nextOpen);
    marketFilterTriggerEl.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    if (nextOpen) {
      marketFilterMenuEl.hidden = false;
      requestAnimationFrame(() => {
        marketFilterMenuEl.classList.add("is-visible");
      });
      return;
    }

    closeMarketFilter();
  });

  marketFilterMenuEl.addEventListener("click", (event) => {
    const option = event.target.closest(".market-filter__option");
    if (!option) {
      return;
    }

    state.activeMarketStatus = option.dataset.filterValue ?? "OPEN";
    syncMarketFilterUi();
    closeMarketFilter();
    loadMarkets(state.activeMarketStatus);
  });

  document.addEventListener("click", (event) => {
    if (!marketFilterEl.contains(event.target)) {
      closeMarketFilter();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMarketFilter();
    }
  });
}

if (assetPickerTriggerEl && assetPickerMenuEl) {
  syncAssetPickerUi();

  assetPickerTriggerEl.addEventListener("click", () => {
    const nextOpen = !assetPickerEl.classList.contains("is-open");
    assetPickerEl.classList.toggle("is-open", nextOpen);
    assetPickerTriggerEl.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    if (nextOpen) {
      assetPickerMenuEl.hidden = false;
      requestAnimationFrame(() => {
        assetPickerMenuEl.classList.add("is-visible");
      });
      return;
    }

    closeAssetPicker();
  });

  assetPickerMenuEl.addEventListener("click", (event) => {
    const option = event.target.closest(".asset-picker__option");
    if (!option) {
      return;
    }

    const asset = option.dataset.assetValue;
    if (!asset || asset === assetEl.value) {
      closeAssetPicker();
      return;
    }

    assetEl.value = asset;
    syncAssetPickerUi();
    closeAssetPicker();
    assetEl.dispatchEvent(new Event("change", { bubbles: true }));
  });

  document.addEventListener("click", (event) => {
    if (!assetPickerEl.contains(event.target)) {
      closeAssetPicker();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAssetPicker();
    }
  });
}

[assetEl, durationEl].forEach((element) => {
  element.addEventListener("change", () => {
    loadCreateContext();
  });
});

createMarketButtonEl.addEventListener("click", handleCreateIntent);

marketGridEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='bet']");
  if (!button) {
    return;
  }

  const card = button.closest("[data-market-address]");
  if (!card) {
    return;
  }

  handleBetIntent(card.dataset.marketAddress, button.dataset.side);
});

positionsListEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='claim']");
  if (!button) {
    return;
  }

  const row = button.closest("[data-position-id]");
  if (!row) {
    return;
  }

  handleClaimIntent(row.dataset.positionId);
});

if (window.TON_CONNECT_UI?.TonConnectUI) {
  try {
    const tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
      manifestUrl,
      buttonRootId: "ton-connect",
    });

    if (isTelegram) {
      tonConnectUI.uiOptions = {
        twaReturnUrl: TWA_RETURN_URL,
      };
    }

    state.tonConnectUI = tonConnectUI;
    syncWalletState(tonConnectUI.wallet);
    tonConnectUI.onStatusChange((wallet) => {
      syncWalletState(wallet);
    });
  } catch (error) {
    const message = `Wallet SDK init failed: ${error instanceof Error ? error.message : String(error)}`;
    walletStatusEl.textContent = "Wallet unavailable";
    walletAddressEl.textContent = message;
    setCreateNotice(message, "error");
    console.error(message);
  }
}

setInterval(() => {
  renderMarkets(state.markets);
  renderPositions(state.positions);
}, 1000);

setInterval(() => {
  if (getActivePanelName() === "markets") {
    loadPrices();
    loadMarkets(state.activeMarketStatus);
  }
  if (getActivePanelName() === "create") {
    loadCreateContext();
  }
  if (
    state.wallet &&
    getActivePanelName() === "profile" &&
    !state.pendingBet &&
    !state.pendingClaim
  ) {
    loadPositions();
  }
}, 30000);

loadPrices();
loadMarkets(state.activeMarketStatus);
clearActionFeedback();
