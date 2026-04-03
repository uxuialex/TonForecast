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
