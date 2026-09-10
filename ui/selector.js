(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const token = /^#view=([a-f0-9]{64})$/i.exec(window.location.hash)?.[1] || null;
  const fragment = token ? `#view=${token}` : "";
  const { assetOrder, drawRing } = window.rebalanceRing;
  const ns = "http://www.w3.org/2000/svg";
  const modes = { "private-key": "Local key", privy: "Privy", ledger: "Ledger" };
  const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  let portfolios = [], authorized = false, canSetup = false, connectedWallet = null;
  let viewReady = !token, connecting = false, setupBusy = false, setupRequest = null, streamed = false, connectionRevision = 0;
  let setupExisting = null;
  let setupState = null, setupController = null, setupGeneration = 0, setupSuspended = document.visibilityState === "hidden", setupAttachmentAllowed = false;
  let pageHidden = false, connectionAttempt = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svgElement(tag, attrs, text) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function safeChartUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      if (!["http:", "https:"].includes(url.protocol) || url.protocol !== window.location.protocol ||
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password ||
          url.pathname !== "/chart" || url.search || url.hash) return null;
      return `${url.href}${fragment}`;
    } catch { return null; }
  }
  async function request(path, body) {
    const response = await fetch(path, { cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    let result;
    try { result = await response.json(); } catch { /* Some rejected local requests have a plain-text response. */ }
    if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error
      : response.status === 403 ? "This view link is unavailable. Open the page again through your agent."
      : "The local app could not complete this request. Check your agent before trying again.");
    if (result === undefined) throw new Error("The local app’s response could not be verified. Check your agent before trying again.");
    return result;
  }
  function targetRows(targets) {
    if (!targets || typeof targets !== "object" || Array.isArray(targets)) return [];
    const entries = Object.entries(targets);
    if (!entries.length || entries.some(([, value]) => !Number.isInteger(value) || value < 0 || value > 10000) || entries.reduce((sum, [, value]) => sum + value, 0) !== 10000) return [];
    return entries.filter(([, value]) => value > 0).sort(([a], [b]) => {
      const left = assetOrder.indexOf(a), right = assetOrder.indexOf(b);
      return (left < 0 ? assetOrder.length : left) - (right < 0 ? assetOrder.length : right) || a.localeCompare(b);
    });
  }
  const hasPrivyPortfolio = () => portfolios.some(portfolio => portfolio.mode === "privy");
  function setSetupButtons() {
    const privyAdded = hasPrivyPortfolio();
    for (const mode of Object.keys(modes)) byId(`setup-${mode}`).disabled = !canSetup || setupBusy || Boolean(setupRequest) || mode === "privy" && privyAdded;
    byId("privy-choice").setAttribute("data-limited", String(privyAdded));
    byId("privy-choice").setAttribute("aria-describedby", privyAdded ? "privy-limit" : "");
    byId("privy-choice").setAttribute("tabindex", privyAdded ? "0" : "-1");
    byId("privy-choice").setAttribute("aria-label", privyAdded ? "Privy unavailable: wallet already added" : "Privy wallet");
    byId("retry-setup").disabled = setupBusy;
    byId("open-existing-portfolio").disabled = !authorized || connecting || !setupExisting;
  }
  function openSetup() {
    if (setupState === "ready") { setupRequest = null; setupState = null; setupExisting = null; byId("open-existing-portfolio").hidden = true; }
    if (!setupRequest) {
      byId("setup-status").textContent = canSetup ? "" : "Open this page through your agent to set up a wallet.";
      clearApproval(); byId("retry-setup").hidden = true;
    }
    setSetupButtons();
    byId("setup-dialog").showModal();
  }
  async function choose(portfolio) {
    if (!viewReady || connecting || pageHidden) return;
    const url = safeChartUrl(portfolio.chartUrl);
    if (!url) { byId("portfolio-status").textContent = "This portfolio’s chart address is unavailable."; return; }
    if (!authorized) { window.location.assign(url); return; }
    connecting = true; render();
    const revision = ++connectionRevision, attempt = ++connectionAttempt;
    byId("portfolio-status").textContent = "Connecting this portfolio to your chat…";
    try {
      const result = await request("/api/connect", { token, wallet: portfolio.wallet });
      if (pageHidden || attempt !== connectionAttempt) return;
      const chartUrl = safeChartUrl(result?.chartUrl);
      if (typeof result?.wallet !== "string" || result.wallet.toLowerCase() !== portfolio.wallet.toLowerCase() || result.tradingChanged !== false || !chartUrl) throw new Error("The portfolio connection could not be verified. Please try again.");
      if (connectionRevision !== revision && connectedWallet?.toLowerCase() !== portfolio.wallet.toLowerCase()) throw new Error("The chat’s portfolio changed while connecting. Select a portfolio again if needed.");
      window.location.assign(chartUrl);
    } catch (error) {
      if (pageHidden || attempt !== connectionAttempt) return;
      byId("portfolio-status").textContent = error instanceof Error ? error.message : "The portfolio could not be connected. Please try again.";
      connecting = false; render();
    }
  }
  function render() {
    setSetupButtons();
    const grid = byId("portfolio-grid");
    grid.replaceChildren();
    for (const portfolio of portfolios) {
      const card = element("button", "portfolio-card");
      card.type = "button"; card.disabled = !viewReady || connecting;
      card.setAttribute("aria-label", `View portfolio ${portfolio.wallet}, chain ${portfolio.chainId}`);
      const top = element("span", "card-top");
      top.append(element("span", "signer", modes[portfolio.mode] || "Signer unavailable"));
      top.append(element("span", `running${portfolio.running === true ? " is-running" : ""}`, portfolio.running === true ? "Running" : portfolio.running === false ? "Stopped" : "Status unavailable"));
      const chain = portfolio.chainId === 4663 ? "Robinhood" : `Chain ${portfolio.chainId}`;
      const linked = authorized && connectedWallet?.toLowerCase() === portfolio.wallet.toLowerCase();
      if (linked) card.className += " is-connected";
      const entries = targetRows(portfolio.targets);
      const preview = element("span", "portfolio-preview");
      const svg = svgElement("svg", { viewBox: "0 0 220 220", "aria-hidden": "true", focusable: "false" });
      const maskId = `preview-mask-${portfolio.wallet.toLowerCase()}`;
      const defs = svgElement("defs", {});
      const mask = svgElement("mask", { id: maskId, maskUnits: "userSpaceOnUse", maskContentUnits: "userSpaceOnUse", x: 0, y: 0, width: 220, height: 220 });
      const dividers = svgElement("g", {}), segments = svgElement("g", {});
      mask.append(svgElement("rect", { x: 0, y: 0, width: 220, height: 220, fill: "white" }), dividers);
      defs.append(mask); svg.append(defs);
      const ring = svgElement("g", { transform: "rotate(-90 110 110)", mask: `url(#${maskId})` });
      ring.append(svgElement("circle", { cx: 110, cy: 110, r: 80, fill: "none", stroke: "#26312a", "stroke-width": 38 }), segments);
      drawRing(segments, dividers, entries.map(([id, weight]) => ({ id, weight })), 80, 38, 110, 110);
      svg.append(ring,
        svgElement("text", { x: 110, y: 109, class: "wallet", "text-anchor": "middle" }, `${portfolio.wallet.slice(0, 6)}…${portfolio.wallet.slice(-4)}`),
        svgElement("text", { x: 110, y: 127, class: "preview-caption", "text-anchor": "middle" }, entries.length ? "Targets" : "Unavailable"));
      preview.append(svg);
      const footer = element("span", "card-footer");
      footer.append(element("span", "target-label", entries.length ? (portfolio.allocationObjective === "user-risk" ? "Targets · User risk" : portfolio.allocationObjective === "sharpe" ? "Targets · Sharpe" : "Target allocation") : "Targets unavailable"));
      footer.append(element("span", "wallet-meta", portfolio.error ? "Needs attention · open your agent" : `${chain}${linked ? " · This chat" : ""}`));
      const details = entries.map(([id, weight]) => `${id} ${percent.format(weight / 100)}%`).join(", ");
      card.setAttribute("title", `${portfolio.wallet}\n${entries.length ? `Saved targets: ${details}` : "Targets unavailable"}`);
      card.append(top, preview, footer, element("span", "sr-only", details));
      card.setAttribute("aria-label", `View portfolio ${portfolio.wallet}. ${modes[portfolio.mode] || "Signer unavailable"}, ${chain}. ${portfolio.running === true ? "Running" : portfolio.running === false ? "Stopped" : "Status unavailable"}. ${entries.length ? `Saved target allocation: ${entries.map(([id, weight]) => `${id} ${percent.format(weight / 100)}%`).join(", ")}.` : "Targets unavailable."}${linked ? " Connected to this chat." : ""}${portfolio.error ? " Configuration needs attention." : ""}`);
      card.addEventListener("click", () => { void choose(portfolio); });
      grid.append(card);
    }
    const add = element("button", "portfolio-card new-portfolio");
    add.id = "new-portfolio"; add.type = "button";
    add.append(element("span", "new-icon", "+"), element("span", "new-label", "New portfolio"), element("span", "new-description", "Choose how to sign"));
    add.addEventListener("click", openSetup); grid.append(add);
  }
  async function loadPortfolios() {
    byId("reload-portfolios").hidden = true;
    byId("portfolio-status").textContent = "Loading portfolios…";
    try {
      const result = await request("/api/portfolios");
      if (!Array.isArray(result?.portfolios)) throw new Error("Portfolio list unavailable.");
      if (!streamed) {
        portfolios = validPortfolios(result.portfolios);
        byId("portfolio-status").textContent = "";
      }
    } catch (error) {
      if (!streamed) {
        byId("portfolio-status").textContent = error instanceof Error ? error.message : "Portfolio list unavailable.";
        byId("reload-portfolios").hidden = false;
      }
    }
    render();
  }
  async function loadView() {
    if (!token) {
      byId("view-notice").textContent = "Viewing only. Open this page through your agent to link a portfolio to your chat or set up a wallet.";
      return;
    }
    try {
      const result = await request("/api/view", { token });
      if (streamed) return;
      if (typeof result?.canSetup !== "boolean" || (result.connectedWallet !== null && (typeof result.connectedWallet !== "string" || !/^0x[0-9a-f]{40}$/i.test(result.connectedWallet)))) throw new Error("View link unavailable.");
      authorized = true; canSetup = result.canSetup; connectedWallet = result.connectedWallet;
      byId("view-notice").textContent = "";
    } catch {
      if (streamed) return;
      byId("view-notice").textContent = "Viewing only. This view link is unavailable; open the page again through your agent to connect your chat.";
    }
    viewReady = true; setSetupButtons(); render();
  }
  function validPortfolios(values) {
    return values.filter((item) => item && typeof item.wallet === "string" && /^0x[0-9a-f]{40}$/i.test(item.wallet) && Number.isSafeInteger(item.chainId) && item.chainId > 0);
  }
  function clearApproval() {
    byId("setup-approval").hidden = true;
    byId("setup-approval-code").textContent = "";
    byId("setup-approval-link").removeAttribute("href");
  }
  function verifiedSetup(value, expected) {
    if (!value || value.requestId !== expected.requestId || value.mode !== expected.mode || value.tradingChanged !== false ||
        !["preparing", "awaiting-approval", "awaiting-device", "ready", "failed"].includes(value.state) ||
        typeof value.message !== "string" || value.message.length > 300) throw new Error();
    if (value.state === "awaiting-approval" && !["privy", "ledger"].includes(value.mode) || value.state === "awaiting-device" && value.mode !== "ledger") throw new Error();
    if (value.approval !== undefined || value.state === "awaiting-approval" && value.mode === "privy") {
      if (value.mode !== "privy" || value.state !== "awaiting-approval" || typeof value.approval?.url !== "string" ||
          value.approval.url.length > 512 || typeof value.approval?.code !== "string" ||
          !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value.approval.code) || value.approval.code.length < 4 || value.approval.code.length > 32) throw new Error();
      const url = new URL(value.approval.url);
      if (url.origin !== "https://agents.privy.io" || url.username || url.password || url.pathname !== "/" || url.hash ||
          [...url.searchParams.keys()].length !== 1 || url.searchParams.get("user_code") !== value.approval.code) throw new Error();
    }
    if (value.state === "ready") {
      if (typeof value.wallet !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.wallet) || !safeChartUrl(value.chartUrl) ||
          value.reused !== undefined && typeof value.reused !== "boolean") throw new Error();
    } else if (value.wallet !== undefined || value.chartUrl !== undefined) throw new Error();
    return value;
  }
  function acceptSetup(value, expected) {
    const result = verifiedSetup(value, expected);
    if (setupRequest !== expected) return true;
    setupExisting = null; byId("open-existing-portfolio").hidden = true;
    setupState = result.state;
    setupBusy = !["ready", "failed"].includes(result.state);
    clearApproval();
    byId("setup-status").textContent = result.message;
    byId("retry-setup").hidden = result.state !== "failed";
    if (result.approval) {
      byId("setup-approval-code").textContent = result.approval.code;
      byId("setup-approval-link").setAttribute("href", result.approval.url);
      byId("setup-approval").hidden = false;
    }
    setSetupButtons();
    if (result.state === "ready" && result.mode === "privy" && result.reused === true) {
      setupAttachmentAllowed = false;
      setupExisting = result;
      byId("setup-status").textContent = `Your signed-in Privy wallet (${result.wallet.slice(0, 6)}…${result.wallet.slice(-4)}) is already added. This connection cannot create another Ethereum wallet.`;
      byId("open-existing-portfolio").hidden = false;
      setSetupButtons();
      return true;
    }
    if (result.state === "ready") {
      const attach = !setupSuspended && setupAttachmentAllowed && byId("setup-dialog").open &&
        connectionRevision === expected.revision && !connecting;
      setupAttachmentAllowed = false;
      byId("setup-status").textContent = attach ? "Portfolio ready. Opening it…" : "Portfolio ready. Select it from the grid.";
      if (attach) { byId("setup-dialog").close(); void choose(result); }
    }
    return !setupBusy;
  }
  function setupUnavailable() {
    setupBusy = false; setupExisting = null; byId("open-existing-portfolio").hidden = true; clearApproval();
    byId("setup-status").textContent = "Setup progress is unavailable. Try again to check the same request.";
    byId("retry-setup").hidden = false;
    setSetupButtons();
  }
  function stopSetupStream() {
    setupGeneration++; setupController?.abort(); setupController = null;
  }
  async function watchSetup(expected) {
    if (setupSuspended || setupRequest !== expected || ["ready", "failed"].includes(setupState)) return;
    stopSetupStream();
    const controller = new AbortController(), generation = setupGeneration;
    setupController = controller;
    let reader = null;
    try {
      const response = await fetch("/api/setup/events", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ token, requestId: expected.requestId }), signal: controller.signal });
      if (!response.ok || !response.body) throw new Error();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!controller.signal.aborted && generation === setupGeneration) {
        const part = await reader.read();
        if (controller.signal.aborted || generation !== setupGeneration) return;
        if (part.done) throw new Error();
        pending += decoder.decode(part.value, { stream: true });
        if (pending.length > 65_536) throw new Error();
        for (let boundary; (boundary = /\r?\n\r?\n/.exec(pending));) {
          const frame = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
          let event = "message";
          const data = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (event === "setup" && data.length && acceptSetup(JSON.parse(data.join("\n")), expected)) return;
        }
      }
    } catch {
      if (!controller.signal.aborted && generation === setupGeneration && setupRequest === expected) setupUnavailable();
    } finally {
      void reader?.cancel().catch(() => {}); reader?.releaseLock(); controller.abort();
      if (setupController === controller) setupController = null;
    }
  }
  async function submitSetup() {
    if (!setupRequest || setupBusy || !canSetup) return;
    const expected = setupRequest;
    stopSetupStream(); setupBusy = true; setSetupButtons(); clearApproval();
    byId("retry-setup").hidden = true;
    byId("setup-status").textContent = "Preparing your wallet…";
    try {
      const result = await request("/api/setup", { token, mode: expected.mode, requestId: expected.requestId });
      if (setupRequest !== expected) return;
      if (!acceptSetup(result, expected)) void watchSetup(expected);
    } catch { if (setupRequest === expected) setupUnavailable(); }
  }
  for (const mode of Object.keys(modes)) byId(`setup-${mode}`).addEventListener("click", () => {
    if (!canSetup || setupBusy || setupRequest || mode === "privy" && hasPrivyPortfolio()) return;
    setupRequest = { mode, requestId: crypto.randomUUID(), revision: connectionRevision };
    setupAttachmentAllowed = true;
    void submitSetup();
  });
  byId("open-existing-portfolio").addEventListener("click", () => {
    if (!setupExisting || !authorized || connecting || !byId("setup-dialog").open) return;
    const portfolio = setupExisting;
    setupAttachmentAllowed = false; byId("setup-dialog").close(); void choose(portfolio);
  });
  byId("retry-setup").addEventListener("click", () => { void submitSetup(); });
  byId("close-setup").addEventListener("click", () => { setupAttachmentAllowed = false; byId("setup-dialog").close(); });
  byId("setup-dialog").addEventListener("close", () => { setupAttachmentAllowed = false; });
  byId("setup-dialog").addEventListener("cancel", () => { setupAttachmentAllowed = false; });
  function resumeSetup() {
    if (!setupSuspended || pageHidden || document.visibilityState === "hidden") return;
    setupSuspended = false;
    if (setupRequest && !["ready", "failed"].includes(setupState)) void watchSetup(setupRequest);
  }
  window.addEventListener("pagehide", () => {
    // Browser Back may restore this document after a completed or pending
    // selection. Old replies cannot navigate it or keep its cards disabled.
    connectionAttempt++;
    if (connecting) byId("portfolio-status").textContent = "";
    connecting = false;
    pageHidden = true; setupSuspended = true; setupAttachmentAllowed = false; stopSetupStream();
  });
  window.addEventListener("pageshow", () => { pageHidden = false; render(); resumeSetup(); });
  document.addEventListener("visibilitychange", () => {
    // Switching to Privy's approval tab keeps the user's setup intent. Only
    // progress delivery pauses; wallet preparation continues independently.
    if (document.visibilityState === "hidden") { setupSuspended = true; stopSetupStream(); }
    else resumeSetup();
  });
  byId("reload-portfolios").addEventListener("click", () => { void loadPortfolios(); });
  window.rebalanceView?.subscribe((update) => {
    if (update.snapshot) {
      if ((streamed || authorized) && connectedWallet?.toLowerCase() !== update.snapshot.connectedWallet?.toLowerCase()) connectionRevision++;
      streamed = true; authorized = true; viewReady = true;
      canSetup = update.snapshot.canSetup; connectedWallet = update.snapshot.connectedWallet;
      portfolios = validPortfolios(update.snapshot.portfolios);
      byId("view-notice").textContent = "";
      if (!connecting) byId("portfolio-status").textContent = "";
      byId("reload-portfolios").hidden = true;
      setSetupButtons(); render();
    } else if (update.error) {
      if (update.unauthorized) { authorized = false; canSetup = false; viewReady = true; setSetupButtons(); render(); }
      byId("view-notice").textContent = update.unauthorized ? "Viewing only. Open this page again through your agent to connect your chat." : "Live connection updates unavailable. You can still select a portfolio; reopen through your agent if needed.";
    }
  });
  setSetupButtons();
  void loadView(); void loadPortfolios();
})();
