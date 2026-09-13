(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const run = byId("portfolio-run"), explorer = byId("wallet-explorer"), explorerLabel = byId("wallet-explorer-label");
  const message = byId("control-message"), retry = byId("ledger-retry");
  const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const states = new Set(["running", "stopped", "starting", "stopping", "setting-up", "unavailable", "deferred"]);
  const validWallet = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
  const same = (a, b) => validWallet(a) && validWallet(b) && a.toLowerCase() === b.toLowerCase();
  const short = (wallet) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  let wallet = null, mode = null, runner = null, attached = null, viewReady = false;
  let statusFresh = false, runnerFresh = false, busy = false, suspended = false;
  let readGeneration = 0, runnerRevision = 0;
  let transitionTimer = null, transitionKey = null, transitionReads = 0, transitionReading = false, transitionDeadline = null;
  let retrySource = null, ledgerConnected = false, retryUnsupported = false, retryBusy = false;
  const attemptedRetries = new Set(), uncertainControls = new Set();
  let messageSource = null;

  function tell(text, source = "control") { message.textContent = text; message.hidden = !text; messageSource = text ? source : null; }
  function suspendControlStreams() {
    const releases = [];
    const release = () => { while (releases.length) releases.pop()(); };
    try {
      // Reserve HTTP/1 slots for an explicit control or a bounded transition read.
      for (const transport of [window.rebalanceView, window.rebalanceStatus]) {
        const resume = transport?.suspendForControl?.();
        if (typeof resume === "function") releases.push(resume);
      }
      return release;
    } catch (error) { release(); throw error; }
  }
  function reconcileTransition() {
    const key = !suspended && !busy && statusFresh && runnerFresh && viewReady &&
      Boolean(window.rebalanceView?.token) && same(wallet, attached) && same(wallet, runner?.wallet) &&
      ["starting", "stopping", "setting-up"].includes(runner.state) ? `${wallet.toLowerCase()}:${runner.state}` : null;
    if (key !== transitionKey) {
      clearTimeout(transitionTimer); transitionTimer = null;
      transitionKey = key; transitionReads = 0;
      transitionDeadline = key && runner.state === "setting-up" ? Date.now() + 300_000 : null;
    }
    if (!key || transitionReading || transitionTimer !== null) return;
    // Process exit need not replace a file after the last Stopping event. Read
    // only during that transition, serially and with a finite retry budget.
    const setup = runner.state === "setting-up";
    if (transitionReads >= (setup ? 300 : 30) || (transitionDeadline !== null && Date.now() >= transitionDeadline)) {
      runner = { wallet, state: "unavailable", message: setup
        ? "Calibur setup status has not settled. It may still finish; refresh the page to check before trying again."
        : "Runner state has not settled. Refresh the page to check it." };
      return;
    }
    const expectedWallet = wallet;
    transitionTimer = setTimeout(async () => {
      transitionTimer = null;
      if (key !== transitionKey) return;
      if (transitionDeadline !== null && Date.now() >= transitionDeadline) { render(); return; }
      transitionReads++; transitionReading = true;
      let releaseStreams = () => {};
      try { releaseStreams = suspendControlStreams(); await refreshRunner(expectedWallet); }
      finally { releaseStreams(); transitionReading = false; render(); }
    }, 1000);
  }
  function setupLabel() {
    return ({ authorizing: "Authorize Calibur…", signing: "Confirm setup…", confirming: "Waiting for setup receipt…" })[runner?.calibur?.state] || "Setting up Calibur…";
  }
  const setupExplanation = "Calibur is Uniswap wallet code that batches token approvals and swaps. First setup needs two Ledger signatures and one transaction paid in ETH; later rebalances need one transaction signature.";
  function render() {
    reconcileTransition();
    const state = runnerFresh && same(wallet, runner?.wallet) ? runner.state : "unavailable";
    // Setup can finish after the accepted Start reply. Surface the current
    // stopped summary on streamed/read-back updates and on a fresh page load.
    // An uncorrelated status read cannot resolve a control with an unknown reply.
    const setupFailure = !suspended && !busy && statusFresh && mode === "ledger" && state === "stopped" &&
      runner?.calibur && typeof runner.message === "string" && !uncertainControls.has(wallet.toLowerCase())
      ? runner.message.trim().slice(0, 400) : "";
    if (setupFailure) tell(setupFailure, "runner");
    else if (messageSource === "runner") tell("");
    run.textContent = busy && run.dataset.action === "stop" ? "Stopping…" : state === "setting-up" ? setupLabel()
      : busy ? "Starting…" : ({ running: "Stop", stopped: "Start", starting: "Starting…", stopping: "Stopping…", deferred: "Start", unavailable: "Unavailable" })[state];
    run.dataset.state = state;
    const linked = Boolean(window.rebalanceView?.token) && viewReady && same(wallet, attached);
    run.disabled = suspended || busy || !statusFresh || !linked || !["running", "stopped"].includes(state);
    run.title = !linked ? "Open this portfolio through your agent to enable controls."
      : !statusFresh ? "Waiting for current portfolio status."
      : state === "running" ? (mode === "ledger" ? "Stop this Ledger portfolio and cancel waiting device prompts. Submitted transactions still settle." : "Stop this portfolio. Submitted transactions still settle.")
      : state === "stopped" ? (mode === "ledger" ? runner?.calibur?.state === "ready"
        ? "Start this Ledger wallet. The backend opens device prompts automatically; physically confirm each transaction."
        : `Start this Ledger wallet. ${setupExplanation} Start checks setup before running.`
        : "Start automatic rebalancing for this wallet with its saved targets.")
      : state === "setting-up" ? `${setupLabel()} ${setupExplanation}`
      : runner?.message || "Waiting for the local runner.";
    run.setAttribute("aria-busy", String(busy || ["starting", "stopping", "setting-up"].includes(state)));
    run.setAttribute("aria-label", `${run.textContent} portfolio${wallet ? ` ${short(wallet)}` : ""}`);
    retry.hidden = mode !== "ledger" || !retrySource;
    retry.disabled = suspended || busy || retryBusy || !statusFresh || !linked || state !== "running" || !ledgerConnected ||
      !retrySource || attemptedRetries.has(retrySource);
    const retryPending = retryBusy || Boolean(retrySource && attemptedRetries.has(retrySource));
    retry.setAttribute("aria-busy", String(retryPending));
    retry.title = !linked ? "Open this portfolio through your agent to enable controls."
      : !statusFresh ? "Waiting for current portfolio status."
      : state !== "running" ? "Start this Ledger portfolio before retrying."
      : !ledgerConnected ? "Connect USB, unlock Ledger and open Ethereum to retry."
      : retryBusy ? "Sending the retry request. Each transaction still requires device confirmation."
      : attemptedRetries.has(retrySource) ? "This retry was sent. Waiting for the current request status."
      : retryUnsupported ? "Retry after resolving Ledger signing support. Each transaction still requires device confirmation."
      : "Prepare a fresh rebalance for this wallet. Physically confirm each transaction on Ledger.";
    const retryLabel = retryBusy ? "Sending Ledger retry" : retryPending ? "Waiting for Ledger retry status" : "Retry Ledger rebalance";
    retry.setAttribute("aria-label", `${retryLabel}${wallet ? ` for ${short(wallet)}` : ""}`);
    // Public navigation follows this chart's wallet, independently of runner/chat controls.
    const available = !suspended && Boolean(wallet);
    if (available) explorer.setAttribute("href", `https://robinhoodchain.blockscout.com/address/${wallet}`);
    else explorer.removeAttribute("href");
    explorer.setAttribute("aria-disabled", String(!available));
    if (available) explorer.removeAttribute("tabindex");
    else explorer.setAttribute("tabindex", "-1");
    explorer.title = available ? `View ${wallet} on the Robinhood explorer` : "Wallet address unavailable";
    explorer.setAttribute("aria-label", available ? `View wallet ${wallet} on the Robinhood explorer (opens in a new tab)` : "Wallet address unavailable");
    explorerLabel.textContent = wallet ? short(wallet) : "Address";
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
    wallet = next;
    mode = next ? snapshot.mode : null;
    statusFresh = !disconnected && Boolean(wallet);
    const request = snapshot?.ledgerRequest;
    retrySource = mode === "ledger" && snapshot.armed === true && snapshot.ledgerPrompt?.suspended === true &&
      request?.state === "finished" && request.chainId === 4663 && same(request.wallet, wallet) && uuid(request.id) ? request.id.toLowerCase() : null;
    ledgerConnected = snapshot?.ledgerPrompt?.connected === true;
    retryUnsupported = request?.outcome === "unsupported";
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
  async function requestRunnerChange(body) {
    const controller = new AbortController();
    let timeout;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch("/api/runner", {
            method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), signal: controller.signal,
          });
          if (!response.ok) throw new Error("Control request unavailable");
          return response.json();
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            // This stops waiting on HTTP; it cannot cancel a dispatched command.
            controller.abort(); reject(new Error("Control outcome is unknown"));
          }, 15000);
        }),
      ]);
    } finally { clearTimeout(timeout); controller.abort(); }
  }
  run.addEventListener("click", async () => {
    if (run.disabled || busy || !same(wallet, runner?.wallet)) return;
    const action = runner.state === "running" ? "stop" : "start";
    const targetWallet = wallet, requestId = crypto.randomUUID(), revision = runnerRevision;
    uncertainControls.delete(targetWallet.toLowerCase());
    busy = true; run.dataset.action = action; tell(""); render();
    let releaseStreams = () => {};
    try {
      // Keep the slots free through the command's read-only reconciliation.
      releaseStreams = suspendControlStreams();
      const result = await requestRunnerChange({ token: window.rebalanceView.token, wallet: targetWallet, action, requestId });
      if (!same(result.wallet, targetWallet) || result.requestId !== requestId || !states.has(result.state) || typeof result.outcome !== "string") throw new Error("Control result unavailable");
      if (result.outcome === "uncertain") uncertainControls.add(targetWallet.toLowerCase());
      if (!suspended && same(wallet, targetWallet)) {
        if (revision === runnerRevision) updateRunner(result);
        const needsAttention = ["blocked", "busy", "deferred", "uncertain"].includes(result.outcome) || ["unavailable", "deferred"].includes(result.state);
        tell(needsAttention && typeof result.message === "string" ? result.message.slice(0, 400) : "");
      }
    } catch {
      uncertainControls.add(targetWallet.toLowerCase());
      if (!suspended && same(wallet, targetWallet)) {
        updateRunner(null, true);
        tell("Could not confirm this request. Its outcome is unknown and it may still finish. Check the runner state before trying again; this request will not be repeated automatically.");
      }
    } finally {
      try { if (!suspended) await refreshRunner(targetWallet); }
      finally {
        releaseStreams();
        busy = false; render();
      }
    }
  });

  retry.addEventListener("click", async () => {
    if (retry.disabled || retry.hidden || retryBusy || !retrySource) return;
    const targetWallet = wallet, retryOf = retrySource, requestId = crypto.randomUUID();
    // A lost reply is not permission for a new signing attempt from stale status.
    attemptedRetries.add(retryOf); retryBusy = true; tell(""); render();
    try {
      const response = await fetch("/api/ledger/retry", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: window.rebalanceView.token, wallet: targetWallet, requestId, retryOf }) });
      if (!response.ok) throw new Error("Retry request unavailable");
      const result = await response.json();
      if (!same(result.wallet, targetWallet) || result.requestId !== requestId || result.retryOf !== retryOf || result.outcome !== "requested") {
        throw new Error("Retry result unavailable");
      }
    } catch {
      attemptedRetries.delete(retryOf); // A later explicit click is still bound to this exact failed request on the server.
      if (!suspended && same(wallet, targetWallet)) tell("Could not confirm the retry. Check the current request status before trying again.");
    } finally { retryBusy = false; render(); }
  });

  window.rebalanceView?.subscribe((update) => {
    if (update.snapshot) { attached = update.snapshot.connectedWallet; viewReady = true; }
    else if (update.error) viewReady = false;
    render();
  });
  window.rebalanceControls = { updateStatus, updateRunner, refreshRunner };
  window.addEventListener("pagehide", () => {
    suspended = true; statusFresh = false; runnerFresh = false; viewReady = false;
    readGeneration++; render();
  });
  window.addEventListener("pageshow", () => { suspended = false; render(); });
  render();
})();
