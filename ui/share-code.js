(() => {
  "use strict";
  // Copies the displayed portfolio's strategy as a share code: targets, drift
  // trigger and cycle interval, never the wallet, signer, RPC or holdings.
  // tests/ui-share.test.ts holds this text to encodeShareCode in src/share.ts.
  const byId = (id) => document.getElementById(id);
  const button = byId("share-code"), label = byId("share-code-label"), message = byId("control-message");
  let code = null, suspended = false, fallback = null, resetTimer = null;

  function percent(bps) {
    const whole = Math.floor(bps / 100), fraction = bps % 100;
    return fraction ? `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}` : String(whole);
  }
  function shareCode(config) {
    const targets = config?.targets;
    if (!targets || typeof targets !== "object" || Array.isArray(targets)) return null;
    const entries = Object.entries(targets);
    const valid = entries.length === 5 && Object.hasOwn(targets, "USDG") &&
      entries.every(([id, bps]) => /^[A-Z]{1,10}$/.test(id) && Number.isInteger(bps) && bps >= 0 && bps <= 10000) &&
      entries.reduce((sum, [, bps]) => sum + bps, 0) === 10000;
    const drift = config.driftThresholdBps, interval = config.rebalanceIntervalSeconds;
    if (!valid || !Number.isInteger(drift) || drift < 0 || drift > 10000 ||
        !Number.isInteger(interval) || interval < 1 || interval > 604800) return null;
    return `rebalance:v1 ${entries.map(([id, bps]) => `${id}=${percent(bps)}`).join(",")} drift=${percent(drift)} interval=${interval}`;
  }
  function render() {
    button.disabled = suspended || !code;
    button.title = code ? "Copy this portfolio's targets, drift trigger and cycle interval as a share code. It never includes the wallet address or holdings."
      : "Share code unavailable until the saved targets load.";
  }
  function update(snapshot, disconnected = false) {
    code = !disconnected && snapshot?.chain?.id === 4663 ? shareCode(snapshot.config) : null;
    render();
  }
  function hideFallback() {
    if (fallback !== null && message.textContent === fallback) { message.textContent = ""; message.hidden = true; }
    fallback = null;
  }
  button.addEventListener("click", async () => {
    if (button.disabled || !code) return;
    const copied = code;
    clearTimeout(resetTimer); label.textContent = "Share"; hideFallback();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(copied);
      label.textContent = "Copied";
      resetTimer = setTimeout(() => { label.textContent = "Share"; }, 2000);
    } catch {
      // Embedded panes can deny clipboard writes; leave the code selectable instead.
      fallback = `Copy this share code: ${copied}`;
      message.textContent = fallback; message.hidden = false;
    }
  });

  window.rebalanceShare = { update };
  window.addEventListener("pagehide", () => {
    suspended = true; code = null;
    clearTimeout(resetTimer); label.textContent = "Share"; render();
  });
  window.addEventListener("pageshow", () => { suspended = false; render(); });
  render();
})();
