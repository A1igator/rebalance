(() => {
  "use strict";
  const ns = "http://www.w3.org/2000/svg";
  const byId = (id) => document.getElementById(id);
  const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const colors = { USDG: "#b4cbb8", AAPL: "#8dbafa", NVDA: "#bad776", MSFT: "#b5a1df", AMD: "#e3a37c" };
  const assetOrder = Object.keys(colors);
  // Match the display-only projection gate in src/fee-projection.ts when a newer status event arrives.
  const projectionNodes = new Set(["intent", "config", "observe", "plan", "interval", "quote", "wait"]);
  const projectionOperations = new Set(["confirmed", "cancelled", "recovered-revert", "needs-rebalance", "cooling-down", "waiting-ledger", "waiting-privy", "stopping"]);
  let lastSnapshot = null;
  let statusDisconnected = false;
  let allocationDescription = "Connecting to the local app.";
  const quoteMaxAgeMs = 90000;
  const quoteIntervalMs = 30000;
  let gasQuote = { gas: null, usd: null };
  let gasReference = null;
  let rebalanceProjection = null;
  let gasRequestFailed = false;
  let gasController = null;
  let gasTimeout = null;
  let gasTimer = null;
  let gasStaleTimer = null;
  let gasGeneration = 0;
  let lastGasFetchAt = null;

  function positive(value) {
    try { return BigInt(value) > 0n; } catch { return false; }
  }
  function unsigned(value) {
    return typeof value === "string" && /^\d{1,78}$/.test(value) ? BigInt(value) : null;
  }
  function units(value, decimals) {
    const unit = 10n ** BigInt(decimals);
    const fraction = (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${value / unit}${fraction ? `.${fraction}` : ""}`;
  }
  function dollars(wei, ethUsdE8, decimals) {
    const numerator = wei * ethUsdE8;
    const denominator = 10n ** 26n;
    const scale = 10n ** BigInt(decimals);
    if (numerator > 0n && numerator * scale < denominator) return `<$${units(1n, decimals)}`;
    const rounded = (numerator * scale + denominator / 2n) / denominator;
    if (decimals === 2) return `$${rounded / 100n}.${(rounded % 100n).toString().padStart(2, "0")}`;
    return `$${units(rounded, decimals)}`;
  }
  function observedAt(value) {
    const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) && timestamp <= Date.now() ? timestamp : null;
  }
  function quotePart(value, at, previous, allowZero) {
    const amount = unsigned(value);
    const timestamp = observedAt(at);
    if (amount !== null && (allowZero || amount > 0n) && timestamp !== null) {
      return { amount, timestamp, failed: false };
    }
    return previous ? { ...previous, failed: true } : null;
  }
  function stale(part) {
    return !part || gasRequestFailed || part.failed || Date.now() - part.timestamp >= quoteMaxAgeMs;
  }
  function sourceNote(part, source) {
    return part ? `${source}, observed ${new Date(part.timestamp).toISOString()}${stale(part) ? "; last known, current quote unavailable" : ""}` : `${source} unavailable`;
  }
  function referenceOf(value) {
    const swapGas = unsigned(value?.swapGas), approvalGas = unsigned(value?.approvalGas);
    const hash = (input) => typeof input === "string" && /^0x[0-9a-fA-F]{64}$/.test(input);
    return value?.chainId === 4663 && swapGas > 0n && approvalGas > 0n && hash(value.swapHash) && hash(value.approvalHash) ? { ...value, swapGas, approvalGas } : null;
  }
  function projectionOf(value) {
    const timestamp = observedAt(value?.observedAt);
    if (!value || !Number.isInteger(value.swaps) || value.swaps < 0 || value.swaps > 16 || timestamp === null || typeof value.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.wallet)) return null;
    const targets = value.targets, balances = value.balances;
    if (!targets || !balances || typeof targets !== "object" || typeof balances !== "object" || Array.isArray(targets) || Array.isArray(balances)) return null;
    const entries = Object.entries(targets);
    if (!entries.length || entries.some(([id, weight]) => !Number.isInteger(weight) || weight < 0 || weight > 10000 || unsigned(balances[id]) === null) || entries.reduce((sum, [, weight]) => sum + weight, 0) !== 10000) return null;
    return { ...value, timestamp };
  }
  function projectionMatches(projection) {
    if (!projection || lastSnapshot?.chain?.id !== 4663 || typeof lastSnapshot?.wallet !== "string" || lastSnapshot.wallet.toLowerCase() !== projection.wallet.toLowerCase()) return false;
    if (lastSnapshot.error !== null || !projectionNodes.has(lastSnapshot.graph?.node)) return false;
    const operation = lastSnapshot.operation;
    if (operation !== null && (!operation || !projectionOperations.has(operation.status) || operation.sendFailure !== undefined ||
        (operation.chainId !== undefined && operation.chainId !== 4663) ||
        (operation.wallet !== undefined && (typeof operation.wallet !== "string" || operation.wallet.toLowerCase() !== projection.wallet.toLowerCase())))) return false;
    const targets = lastSnapshot?.config?.targets;
    if (!targets || Object.keys(targets).length !== Object.keys(projection.targets).length) return false;
    const positions = lastSnapshot?.portfolio?.positions;
    if (!Array.isArray(positions)) return false;
    return Object.entries(projection.targets).every(([id, target]) => {
      const position = positions.find((item) => (item.id || item.symbol) === id);
      return targets[id] === target && position && unsigned(position.balance) !== null && unsigned(position.balance) === unsigned(projection.balances[id]);
    });
  }
  function renderGas() {
    clearTimeout(gasStaleTimer); gasStaleTimer = null;
    const balance = unsigned(lastSnapshot?.nativeBalance);
    const gas = gasQuote.gas;
    const usd = gasQuote.usd;
    const balanceAt = observedAt(lastSnapshot?.updatedAt);
    const balanceStale = statusDisconnected || Boolean(lastSnapshot?.error) || balanceAt === null || Date.now() - balanceAt >= quoteMaxAgeMs;
    const balanceLabel = balance === null ? "ETH gas · unavailable" : `Gas · ${units(balance, 18)} ETH`;
    const balanceUsd = balance !== null && usd ? `${dollars(balance, usd.amount, 2)}${stale(usd) || balanceStale ? " last known" : ""}` : "USD unavailable";
    const gasLabel = gas ? `${units(gas.amount, 9)} gwei${stale(gas) ? " last known" : ""}` : "unavailable";
    const gasUsd = gas && usd ? `${dollars(gas.amount, usd.amount, 12)} / gas${stale(gas) || stale(usd) ? " last known" : ""}` : "USD unavailable";
    byId("gas").textContent = `${balanceLabel}${balance !== null && balanceStale ? " last known" : ""} · ${balanceUsd}`;
    byId("gas-price").textContent = `Gas price · ${gasLabel}`;
    const reference = lastSnapshot?.chain?.id === 4663 ? gasReference : null;
    const costReady = reference && gas && usd;
    const costsStale = stale(gas) || stale(usd);
    byId("gas-estimate").textContent = costReady ? `Swap ≈${dollars(gas.amount * reference.swapGas, usd.amount, 2)} · + approval ≈${dollars(gas.amount * reference.approvalGas, usd.amount, 2)}${costsStale ? " · last known" : ""}` : "Swap estimate · unavailable";
    const projection = projectionMatches(rebalanceProjection) ? rebalanceProjection : null;
    const projectionStale = projection && (gasRequestFailed || statusDisconnected || Boolean(lastSnapshot?.error) || Date.now() - projection.timestamp >= quoteMaxAgeMs);
    let rebalanceLabel = "Rebalance estimate · unavailable";
    if (projection?.swaps === 0) {
      rebalanceLabel = projectionStale ? "Rebalance · $0 (last known projection)" : "Rebalance · $0 (on target)";
    } else if (projection && costReady) {
      const legs = BigInt(projection.swaps);
      const low = dollars(gas.amount * reference.swapGas * legs, usd.amount, 2);
      const high = dollars(gas.amount * (reference.swapGas + reference.approvalGas) * legs, usd.amount, 2);
      rebalanceLabel = `Rebalance ≈${low}–${high} · ${projection.swaps} ${projection.swaps === 1 ? "swap" : "swaps"}${projectionStale || costsStale ? " · last known" : ""}`;
    }
    byId("gas-rebalance").textContent = rebalanceLabel;
    const balanceDetails = `${balanceLabel}; ${balanceAt === null ? "observation time unavailable" : `balance observed ${new Date(balanceAt).toISOString()}`}; ${balanceUsd}; ${sourceNote(usd, "Coinbase ETH/USD spot")}. ETH gas is excluded from portfolio allocation.`;
    const priceDetails = `Gas price ${gasLabel}; ${sourceNote(gas, "Robinhood RPC eth_gasPrice")}; ${gasUsd}; ${sourceNote(usd, "Coinbase ETH/USD spot")}. USD amount is per gas unit, not a transaction fee; a full transaction uses multiple gas units.`;
    const referenceDetails = reference ? `Approximate transaction costs use verified historical single-pool receipts on Robinhood 4663: swap ${reference.swapHash}, ${reference.swapGas} gas; approval ${reference.approvalHash}, ${reference.approvalGas} gas. Gas usage of a new transaction may differ.` : "Historical transaction gas reference unavailable.";
    const projectionDetails = `${rebalanceLabel}. ${projection ? `Fixed-price projection observed ${new Date(projection.timestamp).toISOString()}; matching wallet, targets and balances. The range assumes zero to one approval per swap leg.` : "A fresh projection matching this wallet, allocation and holdings is unavailable."} Estimates exclude market movement, liquidity-provider fees and slippage; they are not a measured rebalance cycle cost.`;
    byId("gas").setAttribute("aria-label", balanceDetails);
    byId("gas-price").setAttribute("aria-label", priceDetails);
    byId("gas-estimate").setAttribute("aria-label", `${byId("gas-estimate").textContent}. ${referenceDetails}`);
    byId("gas-rebalance").setAttribute("aria-label", projectionDetails);
    byId("chart-description").textContent = `${allocationDescription} ${balanceDetails} ${priceDetails} ${referenceDetails} ${projectionDetails}`;
    const deadlines = [gas?.timestamp, usd?.timestamp, balanceAt, projection?.timestamp].filter((timestamp) => timestamp !== null && timestamp !== undefined).map((timestamp) => timestamp + quoteMaxAgeMs).filter((deadline) => deadline > Date.now());
    if (!suspended && deadlines.length) gasStaleTimer = setTimeout(renderGas, Math.min(...deadlines) - Date.now());
  }
  function rows(values) {
    return values.filter(({ weight }) => Number.isInteger(weight) && weight > 0 && weight <= 10000).sort((a, b) => {
      const left = assetOrder.indexOf(a.id), right = assetOrder.indexOf(b.id);
      if (left < 0 && right < 0) return a.id.localeCompare(b.id);
      return (left < 0 ? assetOrder.length : left) - (right < 0 ? assetOrder.length : right);
    });
  }
  function color(id) {
    let hash = 0;
    for (const letter of id) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) | 0;
    return colors[id] || `hsl(${(hash >>> 0) % 360} 55% 70%)`;
  }
  function svgElement(tag, attrs, content) {
    const element = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function drawRing(entries, segmentsId, dividersId, radius, width) {
    const segments = byId(segmentsId), dividers = byId(dividersId);
    segments.replaceChildren(); dividers.replaceChildren();
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    const innerRadius = radius - width / 2, outerRadius = radius + width / 2;
    let offset = 0;
    entries.forEach((entry, index) => {
      const share = entry.weight / total * 100;
      segments.append(svgElement("circle", {
        cx: 270, cy: 270, r: radius, fill: "none", "stroke-width": width, pathLength: 100,
        stroke: color(entry.id), "stroke-dasharray": `${share} ${100 - share}`, "stroke-dashoffset": -offset,
      }));
      if (entries.length > 1) {
        const previousShare = entries[(index + entries.length - 1) % entries.length].weight / total * 100;
        // A straight masked stroke has parallel edges. Limit its width so the
        // two neighboring cuts together remove at most half of a tiny slice.
        const gap = Math.min(4, 2 * innerRadius * Math.sin(Math.min(previousShare, share) * Math.PI / 200));
        const angle = offset / 100 * Math.PI * 2;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        dividers.append(svgElement("line", {
          x1: 270 + cos * (innerRadius - 2), y1: 270 + sin * (innerRadius - 2),
          x2: 270 + cos * (outerRadius + 2), y2: 270 + sin * (outerRadius + 2),
          stroke: "black", "stroke-width": gap, "stroke-linecap": "butt",
        }));
      }
      offset += share;
    });
  }

  function render(snapshot, disconnected = false) {
    const portfolio = snapshot?.portfolio;
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
    const holdings = rows(positions.map((p) => ({ id: String(p.symbol || p.id), weight: p.weightBps })));
    const targets = rows(Object.entries(snapshot?.config?.targets || {}).map(([id, weight]) => ({ id, weight })));
    const funded = positive(portfolio?.totalUsdE8) && holdings.length > 0;
    const failed = disconnected || Boolean(snapshot?.error);
    const receiptWait = { pending: "Waiting for receipt", unresolved: "Transaction unresolved", confirming: "Confirming transaction", "recovery-wait": "Automatic recovery waiting", "recovery-busy": "Recovery in progress" }[snapshot?.operation?.status];
    const entries = funded ? holdings : targets;
    const total = entries.reduce((sum, row) => sum + row.weight, 0);
    const retained = failed || receiptWait || snapshot?.operation?.status === "cooling-down";
    const state = funded ? retained ? "Last known holdings" : "Current holdings" : targets.length ? "Targets" : "No allocation";
    let note = "Set targets through your agent";
    if (funded) {
      const observed = new Date(snapshot.updatedAt);
      note = Number.isFinite(observed.getTime()) ? `As of ${time.format(observed)}` : "Last observed allocation";
    } else if (targets.length) {
      note = portfolio ? positions.some((p) => positive(p.balance)) ? "Holdings below precision" : "Wallet empty" : "Holdings not checked";
    }
    if (receiptWait) note = receiptWait;
    if (failed) note = "Update unavailable";
    byId("state").textContent = state;
    byId("note").textContent = note;
    byId("comparison").textContent = funded && targets.length ? "Outer actual · Inner target" : "";
    byId("chart-title").textContent = state;
    allocationDescription = `${state}. ${note}. ${funded ? "Outer ring, actual holdings" : "Targets only"}: ${entries.map((r) => `${r.id} ${percent.format(r.weight / 100)}%`).join(", ")}.${funded && targets.length ? ` Inner ring, targets: ${targets.map((r) => `${r.id} ${percent.format(r.weight / 100)}%`).join(", ")}.` : ""}`;
    statusDisconnected = disconnected;
    renderGas();
    const labels = byId("labels");
    labels.replaceChildren();
    drawRing(entries, "segments", "actual-dividers", 164, 78);
    drawRing(funded ? targets : [], "target-segments", "target-dividers", 110, 13);
    let offset = 0;
    const placed = [];
    for (const entry of entries) {
      const share = entry.weight / total * 100;
      const angle = ((offset + share / 2) / 100 * 360 - 90) * Math.PI / 180;
      placed.push({ ...entry, x: 270 + Math.cos(angle) * 235, y: 270 + Math.sin(angle) * 235 });
      offset += share;
    }
    if (funded) {
      const targetTotal = targets.reduce((sum, row) => sum + row.weight, 0);
      let targetOffset = 0;
      for (const target of targets) {
        const share = target.weight / targetTotal * 100;
        if (!holdings.some((holding) => holding.id === target.id)) {
          const angle = ((targetOffset + share / 2) / 100 * 360 - 90) * Math.PI / 180;
          placed.push({ id: target.id, weight: 0, x: 270 + Math.cos(angle) * 235, y: 270 + Math.sin(angle) * 235 });
        }
        targetOffset += share;
      }
    }
    // Separate labels on each side when small holdings cluster together.
    for (const side of [placed.filter((p) => p.x < 270), placed.filter((p) => p.x >= 270)]) {
      side.sort((a, b) => a.y - b.y);
      for (let i = 1; i < side.length; i++) side[i].y = Math.max(side[i].y, side[i - 1].y + 53);
      if (side.length) {
        side[side.length - 1].y = Math.min(483, side[side.length - 1].y);
        for (let i = side.length - 2; i >= 0; i--) side[i].y = Math.min(side[i].y, side[i + 1].y - 53);
      }
    }
    for (const entry of placed) {
      let x = Math.min(485, Math.max(55, entry.x));
      const target = targets.find((row) => row.id === entry.id);
      // Center the whole label stack on its polar anchor, keeping the top labels outside the outer ring.
      const y = entry.y - (funded && target ? 18 : 0);
      const stack = [
        svgElement("text", { x, y, class: "ticker" }, entry.id),
        svgElement("text", { x, y: y + 20, class: "weight" }, `${percent.format(entry.weight / 100)}%`),
      ];
      if (funded && target) stack.push(svgElement("text", { x, y: y + 35, class: "target-weight" }, `Target ${percent.format(target.weight / 100)}%`));
      for (const label of stack) labels.append(label);
      // Keep the whole text rectangle outside the circle, including labels moved by collision spacing.
      const measured = stack.map((label) => typeof label.getBBox === "function" ? label.getBBox() : null).filter((box) => box?.width > 0 && box?.height > 0);
      const halfWidth = measured.length ? Math.max(...measured.map((box) => box.width / 2)) : 35;
      const top = measured.length ? Math.min(...measured.map((box) => box.y)) : y - 15;
      const bottom = measured.length ? Math.max(...measured.map((box) => box.y + box.height)) : y + (stack.length === 3 ? 38 : 23);
      const verticalDistance = top > 270 ? top - 270 : bottom < 270 ? 270 - bottom : 0;
      const clearanceRadius = 207;
      if (verticalDistance < clearanceRadius) {
        const distance = Math.sqrt(clearanceRadius ** 2 - verticalDistance ** 2) + halfWidth;
        x = x < 270 ? Math.min(x, 270 - distance) : Math.max(x, 270 + distance);
        for (const label of stack) label.setAttribute("x", x);
      }
    }
  }

  let stream = null;
  let streamReady = false;
  let refreshTimer = null;
  let initialTimer = null;
  let controller = null;
  let refreshing = false;
  let suspended = false;
  let lastRendered = null;
  let streamGeneration = 0;

  async function refreshGas() {
    clearTimeout(gasTimer); gasTimer = null;
    if (suspended || gasController) return;
    const remaining = lastGasFetchAt === null ? 0 : quoteIntervalMs - (Date.now() - lastGasFetchAt);
    if (remaining > 0) { gasTimer = setTimeout(refreshGas, remaining); return; }
    const request = new AbortController();
    gasController = request;
    lastGasFetchAt = Date.now();
    const generation = gasGeneration;
    const timeout = setTimeout(() => request.abort(), 5000);
    gasTimeout = timeout;
    try {
      const response = await fetch("/api/gas", { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Local gas quote unavailable");
      const quote = await response.json();
      if (!quote || typeof quote !== "object" || Array.isArray(quote)) throw new Error("Invalid gas quote");
      if (!suspended && generation === gasGeneration) {
        gasQuote = {
          gas: quotePart(quote.gasPriceWei, quote.gasObservedAt, gasQuote.gas, true),
          usd: quotePart(quote.ethUsdE8, quote.usdObservedAt, gasQuote.usd, false),
        };
        gasReference = referenceOf(quote.reference);
        rebalanceProjection = projectionOf(quote.rebalance);
        gasRequestFailed = false;
        renderGas();
      }
    } catch {
      if (!suspended && generation === gasGeneration) { gasRequestFailed = true; renderGas(); }
    } finally {
      clearTimeout(timeout);
      if (gasController === request) {
        gasController = null;
        gasTimeout = null;
        if (!suspended) gasTimer = setTimeout(refreshGas, Math.max(0, quoteIntervalMs - (Date.now() - lastGasFetchAt)));
      }
    }
  }

  function show(snapshot, disconnected = false) {
    const key = JSON.stringify([snapshot, disconnected]);
    if (key === lastRendered) return;
    lastRendered = key;
    render(snapshot, disconnected);
  }

  function accept(snapshot) {
    if (snapshot?.app !== "Rebalance") throw new Error("Invalid local status");
    lastSnapshot = snapshot;
    show(snapshot);
  }

  async function refresh() {
    refreshTimer = null;
    if (streamReady || suspended || refreshing) return;
    refreshing = true;
    const generation = streamGeneration;
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), 4500);
    try {
      const response = await fetch("/api/status", { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Local status unavailable");
      const snapshot = await response.json();
      if (!streamReady && !suspended && generation === streamGeneration) accept(snapshot);
    } catch {
      if (!streamReady && !suspended) show(lastSnapshot, true);
    } finally {
      clearTimeout(timeout);
      controller = null;
      refreshing = false;
      if (!streamReady && !suspended) refreshTimer = setTimeout(refresh, 5000);
    }
  }

  function fallback() {
    if (!refreshTimer && !refreshing && !suspended) void refresh();
  }

  function connect() {
    if (suspended) return;
    if (typeof EventSource !== "function") { fallback(); return; }
    try {
      const source = new EventSource("/api/status/events");
      stream = source;
      // A silent connection should not leave the chart permanently loading.
      initialTimer = setTimeout(() => { if (!streamReady) fallback(); }, 4500);
      source.addEventListener("status", (event) => {
        if (stream !== source || suspended) return;
        try {
          const snapshot = JSON.parse(event.data);
          accept(snapshot);
          streamGeneration++;
          streamReady = true;
          clearTimeout(initialTimer);
          clearTimeout(refreshTimer); refreshTimer = null;
          controller?.abort();
        } catch {
          streamReady = false;
          source.close(); stream = null;
          fallback();
        }
      });
      // EventSource reconnects itself; polling runs only until a valid event.
      source.onerror = () => {
        if (stream !== source || suspended) return;
        streamReady = false; fallback();
      };
    } catch { fallback(); }
  }

  window.addEventListener("pagehide", () => {
    suspended = true; streamReady = false;
    stream?.close(); stream = null;
    clearTimeout(initialTimer); clearTimeout(refreshTimer); refreshTimer = null;
    controller?.abort();
    gasGeneration++;
    gasController?.abort(); gasController = null;
    clearTimeout(gasTimeout); gasTimeout = null;
    clearTimeout(gasTimer); gasTimer = null;
    clearTimeout(gasStaleTimer); gasStaleTimer = null;
  });
  window.addEventListener("pageshow", () => {
    if (suspended) { suspended = false; connect(); renderGas(); void refreshGas(); }
  });
  connect();
  void refreshGas();
})();
