const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const next = tab.dataset.tab;

    tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
    panels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === next);
    });
  });
});

const assetEl = document.querySelector("#asset");
const directionEl = document.querySelector("#direction");
const durationEl = document.querySelector("#duration");
const thresholdEl = document.querySelector("#threshold");
const previewQuestionEl = document.querySelector("#preview-question");
const walletStatusEl = document.querySelector("#wallet-status");
const walletAddressEl = document.querySelector("#wallet-address");
const marketGridEl = document.querySelector("#market-grid");
const marketFeedbackEl = document.querySelector("#markets-feedback");
const filterEls = document.querySelectorAll(".filter");

const manifestUrl = `${window.location.origin}/tonconnect-manifest.json`;
let activeMarketStatus = "";

function shortAddress(value) {
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function syncWalletState(wallet) {
  if (!wallet) {
    walletStatusEl.textContent = "Wallet not connected";
    walletAddressEl.textContent =
      "Connect a TON wallet to create markets, place bets, and claim payouts.";
    return;
  }

  walletStatusEl.textContent = `${wallet.device.appName} connected`;
  walletAddressEl.textContent = shortAddress(wallet.account.address);
}

if (window.TON_CONNECT_UI?.TonConnectUI) {
  const tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
    manifestUrl,
    buttonRootId: "ton-connect",
  });

  syncWalletState(tonConnectUI.wallet);
  tonConnectUI.onStatusChange((wallet) => {
    syncWalletState(wallet);
  });
}

function getAssetTone(token) {
  if (token === "TON") return "tone-blue";
  if (token === "BTC") return "tone-orange";
  return "tone-green";
}

function getStatusClass(status) {
  return status === "LOCKED" ? "status-pill is-locking" : "status-pill";
}

function formatCountdown(timestampSec) {
  const diff = Math.max(0, timestampSec - Math.floor(Date.now() / 1000));
  const minutes = String(Math.floor(diff / 60)).padStart(2, "0");
  const seconds = String(diff % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
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
      const statusValue =
        market.status === "LOCKED"
          ? "Resolving"
          : market.status.startsWith("RESOLVED")
            ? market.outcome ?? market.status
            : formatCountdown(market.closeAt);

      return `
        <article class="market-card">
          <div class="market-topline">
            <span class="asset-badge ${getAssetTone(market.token)}">${market.token}</span>
            <span class="${getStatusClass(market.status)}">${market.status}</span>
          </div>
          <h3>${market.question}</h3>
          <dl class="market-stats">
            <div><dt>Current</dt><dd>$${market.currentPrice}</dd></div>
            <div><dt>Threshold</dt><dd>$${market.threshold}</dd></div>
            <div><dt>${market.status === "OPEN" ? "Timer" : "Status"}</dt><dd>${statusValue}</dd></div>
            <div><dt>YES pool</dt><dd>${market.yesPool} TON</dd></div>
            <div><dt>NO pool</dt><dd>${market.noPool} TON</dd></div>
            <div><dt>Resolve at</dt><dd>${new Date(market.resolveAt * 1000).toLocaleTimeString()}</dd></div>
          </dl>
          <div class="card-actions">
            <button class="yes-button">Bet YES</button>
            <button class="no-button">Bet NO</button>
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
    const response = await fetch(`/api/markets${query}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    renderMarkets(payload.items ?? []);
  } catch (error) {
    marketGridEl.innerHTML = "";
    marketFeedbackEl.textContent = `Failed to load markets: ${error.message}`;
  }
}

filterEls.forEach((filterEl) => {
  filterEl.addEventListener("click", () => {
    activeMarketStatus = filterEl.dataset.status ?? "";
    filterEls.forEach((item) => item.classList.toggle("is-active", item === filterEl));
    loadMarkets(activeMarketStatus);
  });
});

function syncThresholds() {
  const asset = assetEl.value;
  const presets = {
    TON: ["3.42", "3.43", "3.44"],
    BTC: ["68450", "68500", "68550"],
    ETH: ["3540", "3550", "3560"],
  };

  thresholdEl.innerHTML = presets[asset]
    .map((value, index) => {
      const selected = index === 0 ? " selected" : "";
      return `<option value="${value}"${selected}>${value}</option>`;
    })
    .join("");
}

function syncPreview() {
  const asset = assetEl.value;
  const direction = directionEl.value;
  const duration = durationEl.value;
  const threshold = thresholdEl.value;

  previewQuestionEl.textContent = `Will ${asset} be ${direction} $${threshold} in ${duration} seconds?`;
}

[assetEl, directionEl, durationEl].forEach((element) => {
  element.addEventListener("change", () => {
    if (element === assetEl) {
      syncThresholds();
    }
    syncPreview();
  });
});

thresholdEl.addEventListener("change", syncPreview);

syncThresholds();
syncPreview();
loadMarkets(activeMarketStatus);
