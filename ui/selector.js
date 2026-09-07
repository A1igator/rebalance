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
  function setSetupButtons() {
    for (const mode of Object.keys(modes)) byId(`setup-${mode}`).disabled = !canSetup || setupBusy || Boolean(setupRequest);
    byId("retry-setup").disabled = setupBusy;
  }
  function openSetup() {
    if (!setupRequest) byId("setup-status").textContent = canSetup ? "" : "Open this page through your agent to set up a wallet.";
    setSetupButtons();
    byId("setup-dialog").showModal();
  }
  async function choose(portfolio) {
    if (!viewReady || connecting) return;
    const url = safeChartUrl(portfolio.chartUrl);
    if (!url) { byId("portfolio-status").textContent = "This portfolio’s chart address is unavailable."; return; }
    if (!authorized) { window.location.assign(url); return; }
    connecting = true; render();
    const revision = connectionRevision;
    byId("portfolio-status").textContent = "Connecting this portfolio to your chat…";
    try {
      const result = await request("/api/connect", { token, wallet: portfolio.wallet });
      const chartUrl = safeChartUrl(result?.chartUrl);
      if (typeof result?.wallet !== "string" || result.wallet.toLowerCase() !== portfolio.wallet.toLowerCase() || result.tradingChanged !== false || !chartUrl) throw new Error("The portfolio connection could not be verified. Please try again.");
      if (connectionRevision !== revision && connectedWallet?.toLowerCase() !== portfolio.wallet.toLowerCase()) throw new Error("The chat’s portfolio changed while connecting. Select a portfolio again if needed.");
      window.location.assign(chartUrl);
    } catch (error) {
      byId("portfolio-status").textContent = error instanceof Error ? error.message : "The portfolio could not be connected. Please try again.";
      connecting = false; render();
    }
  }
  function render() {
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
  async function submitSetup() {
    if (!setupRequest || setupBusy || !canSetup) return;
    setupBusy = true; setSetupButtons();
    byId("retry-setup").hidden = true;
    byId("setup-status").textContent = "Sending the setup request to your agent…";
    try {
      const result = await request("/api/setup", { token, ...setupRequest });
      if (result?.requestId !== setupRequest.requestId || !["accepted", "pending", "uncertain"].includes(result.state)) throw new Error("Setup status could not be verified. Check the request with your agent.");
      const messages = { accepted: "Setup request queued. Continue in your agent.", pending: "Setup is pending. Check your agent for the next step.", uncertain: "Setup status is uncertain. Check with your agent before starting another request." };
      byId("setup-status").textContent = typeof result.message === "string" && result.message ? result.message : messages[result.state];
      byId("retry-setup").hidden = result.state === "accepted";
    } catch (error) {
      byId("setup-status").textContent = error instanceof Error ? error.message : "Setup status is unknown. Check the request with your agent.";
      byId("retry-setup").hidden = false;
    }
    setupBusy = false; setSetupButtons();
  }
  for (const mode of Object.keys(modes)) byId(`setup-${mode}`).addEventListener("click", () => {
    if (!canSetup || setupBusy || setupRequest) return;
    setupRequest = { mode, requestId: crypto.randomUUID() };
    void submitSetup();
  });
  byId("retry-setup").addEventListener("click", () => { void submitSetup(); });
  byId("close-setup").addEventListener("click", () => byId("setup-dialog").close());
  byId("reload-portfolios").addEventListener("click", () => { void loadPortfolios(); });
  window.rebalanceView?.subscribe((update) => {
    if (update.snapshot) {
      if (streamed && connectedWallet?.toLowerCase() !== update.snapshot.connectedWallet?.toLowerCase()) connectionRevision++;
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
