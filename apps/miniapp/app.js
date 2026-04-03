const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const assetEl = document.querySelector("#asset");
const durationEl = document.querySelector("#duration");
const previewQuestionEl = document.querySelector("#preview-question");
const walletStatusEl = document.querySelector("#wallet-status");
const walletAddressEl = document.querySelector("#wallet-address");
const marketGridEl = document.querySelector("#market-grid");
const marketFeedbackEl = document.querySelector("#markets-feedback");
const positionsFeedbackEl = document.querySelector("#positions-feedback");
const positionsListEl = document.querySelector("#positions-list");
const filterEls = document.querySelectorAll(".filter");
const priceStripEl = document.querySelector("#price-strip");
const createCurrentPriceEl = document.querySelector("#create-current-price");
const createMarketButtonEl = document.querySelector("#create-market-button");
const actionFeedbackEl = document.querySelector("#action-feedback");

const manifestUrl = `${window.location.origin}/tonconnect-manifest.json`;

const state = {
  activeMarketStatus: "",
  wallet: null,
  tonConnectUI: null,
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
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const next = tab.dataset.tab;

    tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
    panels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === next);
    });
  });
});

function shortAddress(value) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function setActionFeedback(message) {
  actionFeedbackEl.textContent = message;
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
  return "status-pill";
}

function getClaimClass(status) {
  if (status === "CLAIMABLE") return "claim-pill is-claimable";
  if (status === "CLAIMED") return "claim-pill is-claimed";
  if (status === "LOCKED") return "claim-pill is-locking";
  if (status === "LOST") return "claim-pill is-lost";
  return "claim-pill is-open";
}

function getOutcomeLabel(outcome) {
  if (outcome === "YES") return "Yes";
  if (outcome === "NO") return "No";
  return "Pending";
}

function syncWalletState(wallet) {
  state.wallet = wallet;

  if (!wallet) {
    walletStatusEl.textContent = "Wallet not connected";
    walletAddressEl.textContent =
      "Connect a TON wallet to create markets, place bets, and claim payouts.";
    positionsFeedbackEl.textContent = "Connect a wallet to load positions.";
    positionsListEl.innerHTML =
      '<div class="position-empty">Wallet disconnected. Position feed is idle.</div>';
    renderMarkets(state.markets);
    setActionFeedback(
      "Connect a wallet to unlock create, bet, and claim actions.",
    );
    syncCreateButtonState();
    return;
  }

  walletStatusEl.textContent = `${wallet.device.appName} connected`;
  walletAddressEl.textContent = shortAddress(wallet.account.address);
  setActionFeedback(
    "Wallet connected. Create, bet, and claim now go through TON Connect.",
  );
  loadPositions();
  renderMarkets(state.markets);
  syncCreateButtonState();
}

function buildBetButtonLabel(market, side) {
  if (market.direction === "above") {
    return side === "YES" ? "Bet Up" : "Bet Down";
  }
  return side === "YES" ? "Bet Down" : "Bet Up";
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
          ${item.asset}
          <span>$${item.priceUsd}</span>
          <em>${item.fallback ? "fallback" : "live"}</em>
        </div>
      `,
    )
    .join("");
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
    : `${currentPriceText} • Fixed on signature. Resolver source: STON.fi`;
}

function syncCreateButtonState() {
  createMarketButtonEl.disabled = !state.wallet || !state.createContext.canCreate;
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

  if (effectiveStatus === "OPEN") {
    return {
      statusText: "Closes in",
      statusValue: formatCountdown(market.closeAt),
    };
  }

  if (effectiveStatus === "LOCKED") {
    return {
      statusText: "Resolving in",
      statusValue: formatCountdown(market.resolveAt),
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
      const canBet = state.wallet && effectiveStatus === "OPEN";

      return `
        <article class="market-card" data-market-address="${market.contractAddress}">
          <div class="market-topline">
            <span class="asset-badge ${getAssetTone(market.token)}">${market.token}</span>
            <span class="${getStatusClass(effectiveStatus)}">${market.statusLabel}</span>
          </div>
          <h3>${market.question}</h3>
          <dl class="market-stats">
            <div><dt>Current</dt><dd>${market.currentPriceLabel}</dd></div>
            <div><dt>Threshold</dt><dd>${market.thresholdLabel}</dd></div>
            <div><dt>Direction</dt><dd>${market.directionLabel}</dd></div>
            <div><dt>${statusMeta.statusText}</dt><dd>${statusMeta.statusValue}</dd></div>
            <div><dt>Up pool</dt><dd>${market.yesPoolLabel}</dd></div>
            <div><dt>Down pool</dt><dd>${market.noPoolLabel}</dd></div>
            <div><dt>Final price</dt><dd>${market.finalPriceLabel}</dd></div>
            <div><dt>Resolve</dt><dd>${new Date(market.resolveAt * 1000).toLocaleTimeString()}</dd></div>
          </dl>
          <div class="card-actions">
            <button class="yes-button" data-action="bet" data-side="YES" ${canBet && market.onchainReady !== false ? "" : "disabled"}>${buildBetButtonLabel(market, "YES")}</button>
            <button class="no-button" data-action="bet" data-side="NO" ${canBet && market.onchainReady !== false ? "" : "disabled"}>${buildBetButtonLabel(market, "NO")}</button>
          </div>
        </article>
      `;
    })
    .join("");
}

async function loadMarkets(status = "") {
  marketFeedbackEl.textContent = "Loading markets...";

  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const payload = await requestJson(`/api/markets${query}`);
    state.markets = payload.items ?? [];
    renderMarkets(state.markets);
  } catch (error) {
    state.markets = [];
    marketGridEl.innerHTML = "";
    marketFeedbackEl.textContent = `Failed to load markets: ${error.message}`;
  }
}

function renderPositions(items) {
  if (!state.wallet) {
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
            <p class="position-title">${position.question}</p>
            <p class="position-meta">${position.sideLabel} • ${position.amountLabel} • ${position.marketStatusLabel}</p>
          </div>
          <span class="claim-pill ${getClaimClass(position.positionStatus)}">${position.positionStatusLabel}</span>
          <button
            class="primary-button compact-button"
            data-action="claim"
            ${position.claimable && state.wallet ? "" : "disabled"}
          >
            ${position.claimable ? "Claim" : position.claimed ? "Claimed" : "Claim"}
          </button>
        </article>
      `,
    )
    .join("");
}

async function loadPositions() {
  if (!state.wallet) {
    return;
  }

  positionsFeedbackEl.textContent = "Loading positions...";

  try {
    const userAddress = encodeURIComponent(state.wallet.account.address);
    const payload = await requestJson(`/api/positions?userAddress=${userAddress}`);
    state.positions = payload.items ?? [];
    positionsFeedbackEl.textContent = `${state.positions.length} tracked position${state.positions.length === 1 ? "" : "s"}`;
    renderPositions(state.positions);
  } catch (error) {
    state.positions = [];
    positionsFeedbackEl.textContent = `Failed to load positions: ${error.message}`;
    positionsListEl.innerHTML = "";
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
    setActionFeedback("Connect a wallet first. Create action stays locked until wallet connection is live.");
    return;
  }

  if (!state.createContext.canCreate) {
    setActionFeedback(state.createContext.blockedReason || "Create blocked for this asset and duration.");
    return;
  }

  try {
    setActionFeedback("Preparing create transaction...");
    const intent = await requestJson("/api/actions/create-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerAddress: state.wallet.account.address,
        asset: assetEl.value,
        durationSec: Number(durationEl.value),
      }),
    });

    setActionFeedback(`Sign create for ${intent.draft.question}`);
    await sendTonTransaction(intent);
    await requestJson("/api/actions/create-confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractAddress: intent.draft.contractAddress,
      }),
    });

    setActionFeedback(
      `Market submitted: ${intent.draft.question}. Auto-resolver is scheduled, you only need to claim later.`,
    );
    await Promise.all([loadMarkets(state.activeMarketStatus), loadCreateContext()]);
    tabs.forEach((item) => item.classList.toggle("is-active", item.dataset.tab === "markets"));
    panels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === "markets");
    });
  } catch (error) {
    setActionFeedback(`Create failed: ${error.message}`);
  }
}

async function handleBetIntent(contractAddress, side) {
  const market = state.markets.find((item) => item.contractAddress === contractAddress);
  if (!market) {
    return;
  }

  if (!state.wallet) {
    setActionFeedback("Connect a wallet first. Bet buttons unlock only for a connected wallet.");
    return;
  }

  if (deriveEffectiveStatus(market) !== "OPEN") {
    setActionFeedback(`Bet blocked: ${market.statusLabel}. Wait for the next open market.`);
    return;
  }

  const amountTon = window.prompt("Bet amount in TON", "0.01");
  if (!amountTon) {
    return;
  }

  try {
    setActionFeedback(`Preparing ${side === "YES" ? "Up" : "Down"} bet...`);
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

    await sendTonTransaction(intent);
    setActionFeedback(`Bet sent: ${side === "YES" ? "Up" : "Down"} on ${market.question}`);
    await Promise.all([loadMarkets(state.activeMarketStatus), loadPositions()]);
  } catch (error) {
    setActionFeedback(`Bet failed: ${error.message}`);
  }
}

async function handleClaimIntent(positionId) {
  const position = state.positions.find((item) => item.id === positionId);
  if (!position) {
    return;
  }

  if (!state.wallet) {
    setActionFeedback("Connect a wallet first. Claim is available only for the winner wallet.");
    return;
  }

  if (!position.claimable) {
    setActionFeedback(`Claim unavailable: ${position.positionStatusLabel}.`);
    return;
  }

  try {
    setActionFeedback(`Preparing claim for ${position.question}...`);
    const intent = await requestJson("/api/actions/claim-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractAddress: position.contractAddress,
        userAddress: state.wallet.account.address,
      }),
    });

    await sendTonTransaction(intent);
    setActionFeedback(`Claim sent for ${position.question}.`);
    await Promise.all([loadMarkets(state.activeMarketStatus), loadPositions()]);
  } catch (error) {
    setActionFeedback(`Claim failed: ${error.message}`);
  }
}

filterEls.forEach((filterEl) => {
  filterEl.addEventListener("click", () => {
    state.activeMarketStatus = filterEl.dataset.status ?? "";
    filterEls.forEach((item) => item.classList.toggle("is-active", item === filterEl));
    loadMarkets(state.activeMarketStatus);
  });
});

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
  const tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
    manifestUrl,
    buttonRootId: "ton-connect",
  });

  state.tonConnectUI = tonConnectUI;
  syncWalletState(tonConnectUI.wallet);
  tonConnectUI.onStatusChange((wallet) => {
    syncWalletState(wallet);
  });
}

setInterval(() => {
  renderMarkets(state.markets);
  renderPositions(state.positions);
}, 1000);

setInterval(() => {
  loadPrices();
  loadMarkets(state.activeMarketStatus);
  loadCreateContext();
  if (state.wallet) {
    loadPositions();
  }
}, 20000);

loadPrices();
loadMarkets(state.activeMarketStatus);
loadCreateContext();
