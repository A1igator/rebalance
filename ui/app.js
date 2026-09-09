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

  const arcStore = new Map(), tgtStore = new Map();
  function drawRing(entries, container, radius, width, cls, store) {
    const parent = byId(container);
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    const seen = new Set();
    let offset = 0;
    for (const entry of entries) {
      const share = total > 0 ? entry.weight / total * 100 : 0;
      let node = store.get(entry.id);
      if (!node) {
        node = svgElement("circle", { cx: 190, cy: 190, r: radius, fill: "none", "stroke-width": width, pathLength: 100, class: cls });
        store.set(entry.id, node);
      }
      if (node.parentNode !== parent) parent.append(node);
      // A hairline gap reads as a divider without a mask. The gap never exceeds a
      // third of a slice, so at least half of even a dust slice survives, and the
      // drawn arc is never longer than the true allocation share.
      const gap = entries.length > 1 ? Math.min(0.6, share / 3) : 0;
      const length = share > 0 ? Math.max(share - gap, share / 2) : 0;
      node.setAttribute("data-asset", entry.id);
      node.setAttribute("stroke", color(entry.id));
      node.setAttribute("stroke-dasharray", `${length} ${100 - length}`);
      node.setAttribute("stroke-dashoffset", -offset);
      seen.add(entry.id);
      offset += share;
    }
    for (const [id, node] of store) if (!seen.has(id)) { node.remove(); store.delete(id); }
  }

  const modelNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const riskNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
  const displayModelNumber = (value) => Math.abs(value) >= 10000 ? compactNumber.format(value)
    : value !== 0 && Math.abs(value) < 0.01 ? value.toPrecision(2) : modelNumber.format(value);

  function renderRisk(snapshot, disconnected) {
    const summary = snapshot?.config?.allocation;
    const hasTargets = snapshot?.config?.targets && Object.keys(snapshot.config.targets).length > 0;
    let label = hasTargets && summary === undefined ? "Target risk · not set" : "Target risk · unavailable";
    let detail = hasTargets && summary === undefined
      ? "Manual target allocation. User risk inputs are not set. Configure risk through your agent."
      : "The saved target risk model is unavailable. No risk score is inferred from holdings or price movements.";
    const finite = (value) => typeof value === "number" && Number.isFinite(value);
    const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now();
    const metadata = summary && typeof summary === "object" && !Array.isArray(summary) &&
      typeof summary.policyHash === "string" && /^[a-f0-9]{64}$/.test(summary.policyHash) &&
      date(summary.computedAt) && Number.isInteger(summary.horizonMonths) && summary.horizonMonths > 0 && summary.horizonMonths <= 1200 &&
      Number.isInteger(summary.stepBps) && summary.stepBps >= 100 && summary.stepBps <= 1000 && 10000 % summary.stepBps === 0 &&
      finite(summary.score) && finite(summary.expectedReturnBps);
    if (metadata && summary.objective === "user-risk" && summary.returnBasis === "user-horizon" &&
        finite(summary.subjectiveRiskScore) && summary.subjectiveRiskScore > 0 && summary.subjectiveRiskScore <= 100 &&
        finite(summary.benchmarkReturnBps)) {
      const months = summary.horizonMonths;
      const horizon = months % 12 === 0 ? `${months / 12} yr` : `${months} mo`;
      label = `Target risk ${summary.subjectiveRiskScore < 0.1 ? "<0.1" : riskNumber.format(summary.subjectiveRiskScore)}/100 · Return/risk ${displayModelNumber(summary.score)} · ${horizon}`;
      detail = `Saved target allocation model, calculated ${summary.computedAt}. User-selected target risk ${summary.subjectiveRiskScore} points on a 0 to 100 scale over ${months} months, not a probability of loss. ` +
        `Expected total return assumption ${modelNumber.format(summary.expectedReturnBps / 100)}%, benchmark ${modelNumber.format(summary.benchmarkReturnBps / 100)}% over that same horizon. ` +
        `Return/risk ${summary.score}: expected horizon excess return in basis points per user risk point. This custom ratio is not standard Sharpe. These describe target weights, not the current holdings or a realized return.`;
    } else if (metadata && summary.objective === "sharpe" && summary.returnBasis === "history-period" &&
        ["daily", "weekly", "monthly"].includes(summary.history?.interval) &&
        ["tradable-token", "underlying-proxy"].includes(summary.history?.basis) && date(summary.history?.asOf) &&
        typeof summary.history?.quoteCurrency === "string" && /^[A-Z][A-Z0-9_-]{0,15}$/.test(summary.history.quoteCurrency)) {
      label = `Target Sharpe ${displayModelNumber(summary.score)} · ${summary.history.interval} observations`;
      detail = `Saved target allocation model, calculated ${summary.computedAt}. Historical Sharpe ${summary.score}, using ${summary.history.interval} differential returns; not annualized. ` +
        `Historical data as of ${summary.history.asOf}, ${summary.history.basis === "underlying-proxy" ? "underlying-asset proxy" : "tradable-token"} basis in ${summary.history.quoteCurrency}. ` +
        `Historical mean return ${modelNumber.format(summary.expectedReturnBps / 100)}% per observation. Standard Sharpe divides historical mean excess return by its sample standard deviation. ` +
        "These describe target weights with constant weights per observation and no execution costs, not current holdings or a future return guarantee.";
    }
    if (disconnected) {
      label = `Last saved · ${label}`;
      detail = `Connection unavailable. Last saved model only. ${detail}`;
    }
    byId("risk-model").textContent = label;
    byId("risk-model").setAttribute("aria-label", detail);
    byId("risk-model-title").textContent = detail;
    return detail;
  }

  const usdFormat = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  function usdTotal(value) {
    const amount = unsigned(value);
    return amount === null ? null : usdFormat.format(Number(amount / 1000000n) / 100);
  }
  function shortHash(hash) {
    return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${hash.slice(0, 8)}…` : null;
  }
  function duration(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
    if (seconds % 3600 === 0) { const hours = seconds / 3600; return `${hours} ${hours === 1 ? "hour" : "hours"}`; }
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds}s`;
  }

  const holdingRows = new Map();
  function element(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.setAttribute("class", className);
    if (parent) parent.append(node);
    return node;
  }
  function buildRow(id) {
    const el = element("button", "hrow");
    el.setAttribute("type", "button");
    const dot = element("span", "dot", el);
    const name = element("span", "hname", el);
    const tick = element("span", "htick", name);
    const bar = element("span", "bar", name);
    const fill = element("i", "", bar);
    element("u", "", bar);
    const nums = element("span", "hnums", el);
    const act = element("span", "hact", nums);
    const drift = element("span", "hdrift", nums);
    const highlight = (on) => {
      byId("ring").classList.toggle("dim", on);
      const arc = arcStore.get(id);
      if (arc) arc.classList.toggle("on", on);
    };
    for (const [event, on] of [["mouseenter", true], ["mouseleave", false], ["focus", true], ["blur", false]]) {
      el.addEventListener(event, () => highlight(on));
    }
    return { el, dot, tick, bar: fill, act, drift };
  }
  function drawHoldings(entries, targetMap, bandBps, funded) {
    const host = byId("holdings");
    const seen = new Set();
    for (const entry of entries) {
      let row = holdingRows.get(entry.id);
      if (!row) { row = buildRow(entry.id); holdingRows.set(entry.id, row); }
      if (row.el.parentNode !== host) host.append(row.el);
      const target = Object.hasOwn(targetMap, entry.id) ? targetMap[entry.id] : null;
      const drift = funded && target !== null ? entry.weight - target : null;
      row.dot.style.background = color(entry.id);
      row.tick.textContent = entry.id;
      row.act.textContent = `${percent.format(entry.weight / 100)}%`;
      // Bars are comparable across assets: a full half-track is eight percentage points.
      const magnitude = drift === null ? 0 : Math.min(Math.abs(drift) / 800, 1) * 50;
      row.bar.style.width = `${magnitude}%`;
      row.bar.style.left = `${drift !== null && drift < 0 ? 50 - magnitude : 50}%`;
      row.el.classList.toggle("out", drift !== null && Math.abs(drift) >= bandBps);
      row.drift.textContent = drift === null ? (funded ? "no target" : `target ${percent.format(entry.weight / 100)}%`)
        : `${drift >= 0 ? "+" : "\u2212"}${percent.format(Math.abs(drift) / 100)}`;
      row.el.setAttribute("aria-label", `${entry.id} ${percent.format(entry.weight / 100)} percent` +
        (target === null ? "" : `, target ${percent.format(target / 100)} percent`) +
        (drift === null ? "" : `, ${drift >= 0 ? "over" : "under"} by ${percent.format(Math.abs(drift) / 100)} points`));
      seen.add(entry.id);
    }
    for (const [id, row] of holdingRows) if (!seen.has(id)) { row.el.remove(); holdingRows.delete(id); }
  }

  function render(snapshot, disconnected = false) {
    const portfolio = snapshot?.portfolio;
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
    const holdings = rows(positions.map((p) => ({ id: String(p.symbol || p.id), weight: p.weightBps })));
    const targetMap = snapshot?.config?.targets || {};
    const targets = rows(Object.entries(targetMap).map(([id, weight]) => ({ id, weight })));
    const funded = positive(portfolio?.totalUsdE8) && holdings.length > 0;
    const failed = disconnected || Boolean(snapshot?.error);
    const receiptWait = { pending: "Waiting for receipt", unresolved: "Transaction unresolved", confirming: "Confirming transaction", "recovery-wait": "Automatic recovery waiting", "recovery-busy": "Recovery in progress" }[snapshot?.operation?.status];
    const entries = funded ? holdings : targets;
    const bandRaw = snapshot?.config?.driftThresholdBps;
    const band = Number.isInteger(bandRaw) && bandRaw >= 0 && bandRaw <= 10000 ? bandRaw : null;
    let worst = 0;
    if (funded) for (const entry of holdings) {
      const target = Object.hasOwn(targetMap, entry.id) ? targetMap[entry.id] : null;
      if (target !== null && Math.abs(entry.weight - target) > Math.abs(worst)) worst = entry.weight - target;
    }

    let state = "No allocation", sub = "Set targets through your agent", value = "";
    if (failed) { state = funded ? "Last known" : "Unavailable"; sub = "Update unavailable"; }
    else if (receiptWait) { state = "Rebalancing"; sub = receiptWait; }
    else if (funded) {
      const off = `${percent.format(Math.abs(worst) / 100)}% off target`;
      state = band === null ? "Holdings" : Math.abs(worst) >= band ? "Off target" : "On target";
      sub = band === null ? "Drift band unavailable" : off;
    } else if (targets.length) {
      state = "Targets";
      sub = portfolio ? positions.some((p) => positive(p.balance)) ? "Holdings below precision" : "Wallet empty" : "Holdings not checked";
    }
    if (funded) {
      const total = usdTotal(portfolio?.totalUsdE8);
      const observed = new Date(snapshot?.updatedAt);
      const at = Number.isFinite(observed.getTime()) ? time.format(observed) : null;
      value = [total, at ? `as of ${at}` : null].filter(Boolean).join(" · ");
    }
    byId("c-state").textContent = state;
    byId("c-sub").textContent = sub;
    byId("c-val").textContent = value;
    byId("c-legend").textContent = funded && targets.length ? "Outer holdings · inner targets" : targets.length ? "Targets only" : "";
    byId("chart-title").textContent = state;

    drawRing(entries, "arcs", 150, 44, "arc", arcStore);
    drawRing(funded ? targets : [], "targets", 112, 5, "tgt", tgtStore);
    drawHoldings(entries, targetMap, band === null ? 10001 : band, funded);

    // Motion reports settlement: an unconfirmed swap gets a ghost, never a moved arc.
    const moving = receiptWait ? snapshot?.proposal?.sellAssetId : null;
    for (const [id, arc] of arcStore) arc.classList.toggle("active", id === moving);
    const ghost = byId("ghost");
    const ghostTarget = moving !== null && moving !== undefined && funded && Object.hasOwn(targetMap, moving) ? moving : null;
    if (ghostTarget) {
      const total = targets.reduce((sum, row) => sum + row.weight, 0) || 1;
      let offset = 0;
      for (const row of targets) { if (row.id === ghostTarget) break; offset += row.weight / total * 100; }
      const share = targetMap[ghostTarget] / total * 100;
      ghost.setAttribute("stroke", color(ghostTarget));
      ghost.setAttribute("stroke-dasharray", `${share} ${100 - share}`);
      ghost.setAttribute("stroke-dashoffset", -offset);
    }
    ghost.classList.toggle("show", Boolean(ghostTarget));

    const armed = snapshot?.armed === true;
    const hash = shortHash(snapshot?.operation?.hash);
    let summary = "Not armed · start through your agent";
    let pulse = "off";
    if (failed) summary = "Update unavailable · showing last known";
    else if (receiptWait) {
      pulse = "";
      summary = snapshot?.proposal?.reason ? `${snapshot.proposal.reason} · ${receiptWait.toLowerCase()}` : receiptWait;
    } else if (armed) {
      pulse = "idle";
      const next = snapshot?.cycle?.nextEligibleAt ? new Date(snapshot.cycle.nextEligibleAt) : null;
      const at = next && Number.isFinite(next.getTime()) ? ` · next check ${time.format(next)}` : "";
      summary = funded && band !== null && Math.abs(worst) < band ? `Monitoring · within range${at}` : `Monitoring${at}`;
    }
    byId("stext").textContent = summary;
    byId("pulse").className = `pulse${pulse ? ` ${pulse}` : ""}`;

    const allocation = snapshot?.config?.allocation;
    byId("why-ask").textContent = allocation
      ? allocation.objective === "sharpe" ? "Best historical Sharpe" : "Best return for your risk level"
      : targets.length ? "Targets set by hand" : "\u2014";
    const trade = snapshot?.proposal?.reason;
    byId("why-trade").textContent = trade || (funded ? "No trade needed" : "\u2014");
    // An unconfirmed send never renders as a bare hash; uncertainty stays visible.
    const receipt = byId("why-receipt");
    if (hash) {
      const block = snapshot?.operation?.blockNumber;
      const confirmed = snapshot?.operation?.status === "confirmed";
      receipt.textContent = `${confirmed ? "\u2713 " : ""}${hash}${block ? ` blk ${block}` : ""}${confirmed ? "" : " · unconfirmed"}`;
    } else {
      receipt.textContent = receiptWait ? "pending\u2026" : "\u2014";
    }

    byId("set-band").textContent = `Rebalance when off by · ${band === null ? "unavailable" : `\u00b1${percent.format(band / 100)}%`}`;
    const every = duration(snapshot?.config?.rebalanceIntervalSeconds);
    byId("set-every").textContent = `Check every · ${every || "unavailable"}`;
    const modes = { "private-key": "Local key", privy: "Privy", ledger: "Ledger" };
    byId("set-sign").textContent = `Signing · ${modes[snapshot?.mode] || "unavailable"}`;

    allocationDescription = `${state}. ${sub}. ${funded ? "Outer ring, actual holdings" : "Targets only"}: ${entries.map((r) => `${r.id} ${percent.format(r.weight / 100)}%`).join(", ")}.${funded && targets.length ? ` Inner ring, targets: ${targets.map((r) => `${r.id} ${percent.format(r.weight / 100)}%`).join(", ")}.` : ""}`;
    allocationDescription += ` ${renderRisk(snapshot, disconnected)}`;
    statusDisconnected = disconnected;
    renderGas();
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
