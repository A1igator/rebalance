(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const run = byId("portfolio-run"), copy = byId("copy-address"), copyLabel = byId("copy-address-label");
  const message = byId("control-message"), fallback = byId("funding-fallback"), address = byId("funding-address");
  const states = new Set(["running", "stopped", "starting", "stopping", "unavailable", "deferred"]);
  const validWallet = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
  const same = (a, b) => validWallet(a) && validWallet(b) && a.toLowerCase() === b.toLowerCase();
  const short = (wallet) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  let wallet = null, runner = null, attached = null, viewReady = false;
  let statusFresh = false, runnerFresh = false, busy = false, copying = false, suspended = false;
  let copyTimer = null, copyGeneration = 0, readGeneration = 0, runnerRevision = 0, messageRevision = 0;

  function tell(text) { messageRevision++; message.textContent = text; message.hidden = !text; }
  function render() {
    const state = runnerFresh && same(wallet, runner?.wallet) ? runner.state : "unavailable";
    run.textContent = busy ? (run.dataset.action === "stop" ? "Stopping…" : "Starting…")
      : ({ running: "Stop", stopped: "Start", starting: "Starting…", stopping: "Stopping…", deferred: "Start", unavailable: "Unavailable" })[state];
    run.dataset.state = state;
    const linked = Boolean(window.rebalanceView?.token) && viewReady && same(wallet, attached);
    run.disabled = suspended || busy || !statusFresh || !linked || !["running", "stopped"].includes(state);
    run.title = !linked ? "Open this portfolio through your agent to enable controls."
      : !statusFresh ? "Waiting for current portfolio status."
      : state === "running" ? "Stop this portfolio. Submitted transactions still settle."
      : state === "stopped" ? "Start automatic rebalancing for this wallet with its saved targets."
      : runner?.message || "Waiting for the local runner.";
    run.setAttribute("aria-label", `${run.textContent} portfolio${wallet ? ` ${short(wallet)}` : ""}`);
    copy.disabled = suspended || !wallet || copying;
    copy.title = wallet ? `Copy ${wallet} · Robinhood chain 4663` : "Wallet address unavailable";
    copy.setAttribute("aria-label", wallet ? `Copy funding address ${wallet} on Robinhood chain 4663` : "Funding address unavailable");
    if (!copying && !copyTimer) copyLabel.textContent = wallet ? short(wallet) : "Address";
  }

  function updateRunner(value, disconnected = false) {
    runnerRevision++;
    if (disconnected || !value || !validWallet(value.wallet) || !states.has(value.state)) {
      runnerFresh = false;
    } else {
      runner = value; runnerFresh = true;
    }
    render();
  }
  function updateStatus(snapshot, disconnected = false) {
    const next = snapshot?.chain?.id === 4663 && validWallet(snapshot.wallet) ? snapshot.wallet : null;
    if (next !== wallet) {
      wallet = next; copyGeneration++;
      clearTimeout(copyTimer); copyTimer = null; copying = false;
      fallback.hidden = true; address.value = "";
    }
    statusFresh = !disconnected && Boolean(wallet);
    render();
  }
  async function refreshRunner(expectedWallet) {
    const generation = ++readGeneration, revision = runnerRevision;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch("/api/runner", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Runner status unavailable");
      const result = await response.json();
      if (!suspended && generation === readGeneration && revision === runnerRevision && same(wallet, expectedWallet)) updateRunner(result);
    } catch {
      if (!suspended && generation === readGeneration && revision === runnerRevision && same(wallet, expectedWallet)) updateRunner(null, true);
    } finally { clearTimeout(timeout); }
  }
  run.addEventListener("click", async () => {
    if (run.disabled || busy || !same(wallet, runner?.wallet)) return;
    const action = runner.state === "running" ? "stop" : "start";
    const targetWallet = wallet, requestId = crypto.randomUUID(), revision = runnerRevision;
    busy = true; run.dataset.action = action; tell(""); render();
    try {
      const response = await fetch("/api/runner", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: window.rebalanceView.token, wallet: targetWallet, action, requestId }),
      });
      if (!response.ok) throw new Error("Control request unavailable");
      const result = await response.json();
      if (!same(result.wallet, targetWallet) || result.requestId !== requestId || !states.has(result.state) || typeof result.outcome !== "string") throw new Error("Control result unavailable");
      if (!suspended && same(wallet, targetWallet)) {
        if (revision === runnerRevision) updateRunner(result);
        const needsAttention = ["blocked", "busy", "deferred", "uncertain"].includes(result.outcome) || ["unavailable", "deferred"].includes(result.state);
        tell(needsAttention && typeof result.message === "string" ? result.message.slice(0, 400) : "");
      }
    } catch {
      if (!suspended && same(wallet, targetWallet)) {
        updateRunner(null, true);
        tell("Could not confirm the request. The button shows the latest runner state.");
      }
    } finally {
      if (!suspended) await refreshRunner(targetWallet);
      busy = false; render();
    }
  });

  copy.addEventListener("click", async () => {
    if (copy.disabled || !wallet) return;
    const targetWallet = wallet, generation = ++copyGeneration;
    copying = true; clearTimeout(copyTimer); copyTimer = null; fallback.hidden = true; render();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(targetWallet);
      if (!suspended && generation === copyGeneration && same(wallet, targetWallet)) {
        copyLabel.textContent = "Copied";
        tell("Funding address copied · Robinhood chain 4663.");
        const feedbackRevision = messageRevision;
        copyTimer = setTimeout(() => { copyTimer = null; if (messageRevision === feedbackRevision) tell(""); render(); }, 1800);
      }
    } catch {
      if (!suspended && generation === copyGeneration && same(wallet, targetWallet)) {
        address.value = targetWallet; fallback.hidden = false;
        address.focus(); address.select();
        tell("Copy the selected address · Robinhood chain 4663.");
      }
    } finally {
      if (generation === copyGeneration) copying = false;
      render();
    }
  });
  window.rebalanceView?.subscribe((update) => {
    if (update.snapshot) { attached = update.snapshot.connectedWallet; viewReady = true; }
    else if (update.error) viewReady = false;
    render();
  });
  window.rebalanceControls = { updateStatus, updateRunner, refreshRunner };
  window.addEventListener("pagehide", () => {
    suspended = true; statusFresh = false; runnerFresh = false; viewReady = false;
    copyGeneration++; copying = false; readGeneration++;
    clearTimeout(copyTimer); copyTimer = null; render();
  });
  window.addEventListener("pageshow", () => { suspended = false; render(); });
  render();
})();
