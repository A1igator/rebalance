"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  const quoteValue = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const smallQuoteValue = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
  const percentage = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const quantity = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
  const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let lastSnapshot = null;
  let lastRender = "";

  function text(id, value) { byId(id).textContent = value; }
  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function numeric(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function bps(value) { return Math.max(0, Math.min(10000, numeric(value) ?? 0)); }
  function percent(value) { return `${percentage.format((numeric(value) ?? 0) / 100)}%`; }
  function money(value, isPrice = false) {
    const amount = numeric(value);
    if (amount === null) return "—";
    const units = amount / 1e8;
    if (units > 0 && units < (isPrice ? 0.000001 : 0.01)) return isPrice ? "<0.000001" : "<0.01";
    return (isPrice && units > 0 && units < 1 ? smallQuoteValue : quoteValue).format(units);
  }
  function balance(value, decimals) {
    const amount = numeric(value);
    const places = numeric(decimals);
    if (amount === null || places === null || places < 0 || places > 255) return "—";
    const units = amount / 10 ** places;
    if (!Number.isFinite(units)) return "—";
    if (units > 0 && units < 0.000001) return "<0.000001";
    return quantity.format(units);
  }
  function assetColor(id) {
    let hash = 2166136261;
    for (const character of String(id)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    const hue = (hash >>> 0) % 360;
    return `hsl(${hue} 62% 73%)`;
  }
  function pretty(value) {
    return String(value || "Waiting").replace(/[_-]+/g, " ").replace(/^\w/, (character) => character.toUpperCase());
  }
  function setConnection(state, message) {
    byId("connection").dataset.state = state;
    text("connection-text", message);
  }
  function showNotice(message) {
    byId("notice").hidden = !message;
    text("notice-text", message || "");
  }

  function renderTotal(portfolio) {
    const formatted = portfolio ? money(portfolio.totalUsdE8) : "—";
    const total = byId("portfolio-total");
    total.replaceChildren();
    const point = formatted.lastIndexOf(".");
    if (point > 0 && formatted.length - point === 3 && !formatted.startsWith("<")) {
      total.append(document.createTextNode(formatted.slice(0, point)), node("span", "total-decimal", formatted.slice(point)));
    } else total.textContent = formatted;
  }

  function renderChart(positions, portfolio) {
    const group = byId("chart-segments");
    group.replaceChildren();
    const positive = positions.filter((position) => bps(position.weightBps) > 0);
    const sum = positive.reduce((total, position) => total + bps(position.weightBps), 0);
    let offset = 0;
    for (const position of positive) {
      const share = bps(position.weightBps) / sum * 100;
      const gap = positive.length > 1 && share > 1.3 ? 0.7 : 0;
      const segment = document.createElementNS(svgNS, "circle");
      for (const [key, value] of Object.entries({ cx: 130, cy: 130, r: 100, fill: "none", "stroke-width": 24, pathLength: 100, stroke: assetColor(position.id), "stroke-dasharray": `${share - gap} ${100 - share + gap}`, "stroke-dashoffset": -offset })) {
        segment.setAttribute(key, String(value));
      }
      group.append(segment);
      offset += share;
    }
    const count = positive.length;
    text("asset-count", portfolio ? `${positions.length} ${positions.length === 1 ? "asset" : "assets"}` : "No assets yet");
    if (sum > 0) {
      text("chart-center-label", "Spread across");
      text("chart-center-value", `${count} ${count === 1 ? "asset" : "assets"}`);
      text("chart-center-note", "Current holdings");
      byId("allocation-chart").setAttribute("aria-label", `Current allocation: ${positive.map((position) => `${position.symbol || position.id} ${percent(position.weightBps)}`).join(", ")}`);
    } else {
      text("chart-center-label", portfolio ? "Ready when you are" : "A fresh start");
      text("chart-center-value", portfolio ? "No holdings" : "Your portfolio");
      text("chart-center-note", portfolio ? "Waiting for a balance" : "will appear here");
      byId("allocation-chart").setAttribute("aria-label", portfolio ? "Current portfolio has no allocation to display" : "No portfolio data yet");
    }
  }

  function renderAllocations(positions, config, hasPortfolio) {
    const container = byId("allocations");
    container.replaceChildren();
    const rows = positions.map((position) => ({ id: position.id, symbol: position.symbol || position.id, target: bps(position.targetBps), current: bps(position.weightBps) }));
    const existing = new Set(rows.map((position) => position.id));
    if (config && config.targets && typeof config.targets === "object") {
      for (const [id, target] of Object.entries(config.targets)) {
        if (!existing.has(id)) rows.push({ id, symbol: id, target: bps(target), current: null });
      }
    }
    byId("allocation-empty").hidden = rows.length > 0;
    byId("allocations").hidden = rows.length === 0;
    byId("allocation-summary").firstElementChild.textContent = rows.length
      ? hasPortfolio ? "Target markers show where you want to be." : "Targets saved. Waiting for portfolio data."
      : "Set your direction through your agent.";
    for (const position of rows) {
      const row = node("div", "allocation-row");
      const labels = node("div", "allocation-labels");
      const asset = node("div", "asset-label");
      const swatch = node("span", "asset-swatch");
      swatch.style.backgroundColor = assetColor(position.id);
      swatch.setAttribute("aria-hidden", "true");
      asset.append(swatch, node("span", "asset-symbol", position.symbol));
      const numbers = node("div", "allocation-numbers");
      numbers.append(node("span", "", position.current === null ? "—" : percent(position.current)), node("span", "target-number", `/ ${percent(position.target)}`));
      numbers.setAttribute("aria-label", `${position.current === null ? "Current allocation unavailable" : `Current ${percent(position.current)}`}, target ${percent(position.target)}`);
      labels.append(asset, numbers);
      const track = node("div", "allocation-track");
      track.setAttribute("aria-hidden", "true");
      const fill = node("span", "allocation-fill");
      fill.style.width = `${(position.current ?? 0) / 100}%`;
      fill.style.backgroundColor = assetColor(position.id);
      const target = node("span", "allocation-target");
      target.style.left = `${position.target / 100}%`;
      track.append(fill, target);
      row.append(labels, track);
      container.append(row);
    }
  }

  function renderHoldings(positions, hasPortfolio) {
    const body = byId("holdings-body");
    body.replaceChildren();
    byId("holdings-empty").hidden = positions.length > 0;
    if (!positions.length) {
      const copy = byId("holdings-empty").querySelector("p");
      copy.replaceChildren(document.createTextNode(hasPortfolio ? "There are no assets in this portfolio." : "No holdings to display yet."), node("span", "", "Configured assets appear after the first portfolio refresh."));
    }
    for (const position of positions) {
      const row = node("tr");
      const assetCell = node("td");
      const asset = node("div", "table-asset");
      const icon = node("span", "asset-icon", String(position.symbol || position.id).slice(0, 2).toUpperCase());
      icon.setAttribute("aria-hidden", "true");
      icon.style.color = assetColor(position.id);
      const names = node("div", "asset-name-stack");
      names.append(node("span", "asset-symbol", position.symbol || position.id));
      if (position.id && position.id !== position.symbol) names.append(node("span", "asset-id", position.id));
      asset.append(icon, names);
      assetCell.append(asset);
      const driftValue = numeric(position.driftBps);
      const driftCell = node("td");
      const drift = node("span", "drift", driftValue === null ? "—" : `${driftValue > 0 ? "+" : driftValue < 0 ? "−" : ""}${percentage.format(Math.abs(driftValue) / 100)}`);
      drift.dataset.direction = driftValue > 0 ? "over" : driftValue < 0 ? "under" : "equal";
      drift.setAttribute("aria-label", driftValue === null ? "Drift unavailable" : `${percentage.format(Math.abs(driftValue) / 100)} percentage points ${driftValue > 0 ? "above target" : driftValue < 0 ? "below target" : "from target"}`);
      driftCell.append(drift);
      row.append(assetCell, node("td", "secondary-number", balance(position.balance, position.decimals)), node("td", "secondary-number", money(position.priceUsdE8, true)), node("td", "", money(position.valueUsdE8)), node("td", "", percent(position.weightBps)), node("td", "secondary-number", percent(position.targetBps)), driftCell);
      body.append(row);
    }
  }

  function renderOperation(operation, updatedAt) {
    const status = String(operation?.status || "waiting");
    const failed = /error|fail|rejected|unresolved/i.test(status);
    const pending = /pending|waiting|sign|confirm|rebalance|connect|approv/i.test(status) && !/confirmed|complete/i.test(status);
    const badge = byId("operation-badge");
    badge.textContent = pretty(status);
    badge.dataset.state = failed ? "error" : pending ? "pending" : "normal";
    text("operation-title", operation ? pretty(status) : "Nothing to report yet.");
    text("operation-message", operation?.message || (operation?.hash ? "Transaction details are recorded by the local app." : operation ? "The local app is monitoring this operation." : "Rebalance activity appears here as it happens."));
    byId("transaction-hash").hidden = !operation?.hash;
    text("transaction-hash", operation?.hash ? `Transaction · ${operation.hash}` : "");
    const date = updatedAt ? new Date(updatedAt) : null;
    const valid = date && Number.isFinite(date.getTime());
    text("updated-at", valid ? timeFormat.format(date) : "—");
    if (valid) byId("updated-at").dateTime = date.toISOString();
    else byId("updated-at").removeAttribute("datetime");
  }

  function renderGraph(graph) {
    const available = graph && typeof graph.node === "string";
    byId("graph-card").hidden = !available;
    if (!available) return;
    const normalize = (value) => String(value).toLowerCase().replace(/[^a-z]/g, "");
    const current = normalize(graph.node);
    const stages = [
      ["Config", ["config", "configure", "intent", "agentinputconfig", "targetsetting"]],
      ["Observe", ["observe", "observation", "observedportfolio", "observing"]],
      ["Plan", ["plan", "deterministicplan", "planning"]],
      ["Execute", ["execute", "execution", "executing"]],
      ["Receipt", ["receipt", "receiptfeedback", "reconcile", "reconciliation"]]
    ];
    const list = byId("graph-stages");
    list.replaceChildren();
    for (const [label, aliases] of stages) {
      const item = node("li", "graph-stage", label);
      if (aliases.includes(current)) item.setAttribute("aria-current", "step");
      list.append(item);
    }
    text("graph-current", `Current node · ${pretty(graph.node)}`);
    const trace = Array.isArray(graph.trace) ? graph.trace.filter((entry) => typeof entry === "string") : [];
    byId("graph-trace").hidden = trace.length === 0;
    text("graph-trace", trace.length ? `Recent path · ${trace.join(" → ")}` : "");
  }

  function render(snapshot) {
    const portfolio = snapshot.portfolio || null;
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions.filter((position) => position && typeof position === "object") : [];
    const chainName = snapshot.chain?.name || "Robinhood";
    text("network-name", chainName);
    text("network-detail", `${chainName} · ${snapshot.chain?.id ?? 4663}`);
    text("wallet-address", snapshot.wallet || "Not configured");
    const modeLabels = { "private-key": "Local private key · automatic", privy: "Privy · automatic", ledger: "Ledger · device confirmation" };
    text("signing-mode", modeLabels[snapshot.mode] || "Not configured");
    text("monitor-state", snapshot.armed === true ? "Armed" : "Stopped");
    const modeNotes = { "private-key": "Rebalances run locally without LLM input.", privy: "Calculated locally. Signing uses Privy’s hosted infrastructure.", ledger: "Monitoring uses your public address. Signing requires your device." };
    text("profile-note", modeNotes[snapshot.mode] || "Configure your profile through your coding agent.");
    text("value-caption", portfolio ? positions.length ? "Combined value of configured assets" : "No asset balances to display" : snapshot.config ? "Waiting for the first portfolio refresh" : "Waiting for your local portfolio");
    renderTotal(portfolio);
    renderChart(positions, portfolio);
    renderAllocations(positions, snapshot.config, Boolean(portfolio));
    renderHoldings(positions, Boolean(portfolio));
    renderOperation(snapshot.operation, snapshot.updatedAt);
    renderGraph(snapshot.graph);
  }

  async function refresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch("/api/status", { method: "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Local status request failed (${response.status}).`);
      const snapshot = await response.json();
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.app !== "Rebalance") throw new Error("The local app returned an unreadable status.");
      lastSnapshot = snapshot;
      const serialized = JSON.stringify(snapshot);
      if (serialized !== lastRender) {
        render(snapshot);
        lastRender = serialized;
      }
      setConnection(snapshot.error ? "error" : "live", snapshot.error ? "Portfolio refresh needs attention" : "Local app connected · refreshes every 5s");
      showNotice(snapshot.error ? `Portfolio update paused. ${snapshot.error}${snapshot.portfolio ? " Displaying the last available portfolio." : ""}` : null);
    } catch (error) {
      setConnection("error", "Local app unavailable");
      showNotice(`${error.name === "AbortError" ? "The local app did not respond in time." : "Unable to refresh the local portfolio."} ${lastSnapshot?.portfolio ? "Displaying the last available portfolio. " : ""}Check the app through your coding agent. This view will reconnect automatically.`);
    } finally {
      clearTimeout(timeout);
      setTimeout(refresh, 5000);
    }
  }

  refresh();
})();
