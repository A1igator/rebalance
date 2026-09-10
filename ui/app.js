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
    // Values only; the labels are static markup, so the numbers line up in a
    // column instead of hiding inside four sentences. Staleness is said once
    // per row rather than after every fragment it touches.
    const known = (text, isStale) => `${text}${isStale ? " · last known" : ""}`;
    // A missing conversion is stated, never silently dropped: an ETH figure with
    // no dollar figure beside it would read as if none was expected.
    byId("gas").textContent = balance === null ? "unavailable"
      : known(`${units(balance, 18)} ETH · ${usd ? dollars(balance, usd.amount, 2) : "USD unavailable"}`,
          balanceStale || (usd ? stale(usd) : false));
    byId("gas-price").textContent = gas ? known(`${units(gas.amount, 9)} gwei`, stale(gas)) : "unavailable";
    const reference = lastSnapshot?.chain?.id === 4663 ? gasReference : null;
    const costReady = reference && gas && usd;
    const costsStale = stale(gas) || stale(usd);
    byId("gas-estimate").textContent = costReady
      ? known(`≈${dollars(gas.amount * reference.swapGas, usd.amount, 2)} · +${dollars(gas.amount * reference.approvalGas, usd.amount, 2)} approval`, costsStale)
      : "unavailable";
    const projection = projectionMatches(rebalanceProjection) ? rebalanceProjection : null;
    const projectionStale = projection && (gasRequestFailed || statusDisconnected || Boolean(lastSnapshot?.error) || Date.now() - projection.timestamp >= quoteMaxAgeMs);
    let rebalanceLabel = "unavailable";
    if (projection?.swaps === 0) {
      rebalanceLabel = known("$0 · on target", Boolean(projectionStale));
    } else if (projection && costReady) {
      const legs = BigInt(projection.swaps);
      const low = dollars(gas.amount * reference.swapGas * legs, usd.amount, 2);
      const high = dollars(gas.amount * (reference.swapGas + reference.approvalGas) * legs, usd.amount, 2);
      rebalanceLabel = known(`≈${low}–${high} · ${projection.swaps} ${projection.swaps === 1 ? "swap" : "swaps"}`, Boolean(projectionStale) || costsStale);
    }
    byId("gas-rebalance").textContent = rebalanceLabel;
    const balanceDetails = `${balanceLabel}; ${balanceAt === null ? "observation time unavailable" : `balance observed ${new Date(balanceAt).toISOString()}`}; ${balanceUsd}; ${sourceNote(usd, "Coinbase ETH/USD spot")}. ETH gas is excluded from portfolio allocation.`;
    const priceDetails = `Gas price ${gasLabel}; ${sourceNote(gas, "Robinhood RPC eth_gasPrice")}; ${gasUsd}; ${sourceNote(usd, "Coinbase ETH/USD spot")}. USD amount is per gas unit, not a transaction fee; a full transaction uses multiple gas units.`;
    const referenceDetails = reference ? `Approximate transaction costs use verified historical single-pool receipts on Robinhood 4663: swap ${reference.swapHash}, ${reference.swapGas} gas; approval ${reference.approvalHash}, ${reference.approvalGas} gas. Gas usage of a new transaction may differ.` : "Historical transaction gas reference unavailable.";
    const projectionDetails = `Approximate cost of a full rebalance: ${rebalanceLabel}. ${projection ? `Fixed-price projection observed ${new Date(projection.timestamp).toISOString()}; matching wallet, targets and balances. The range assumes zero to one approval per swap leg.` : "A fresh projection matching this wallet, allocation and holdings is unavailable."} Estimates exclude market movement, liquidity-provider fees and slippage; they are not a measured rebalance cycle cost.`;
    byId("gas").setAttribute("aria-label", balanceDetails);
    byId("gas-price").setAttribute("aria-label", priceDetails);
    byId("gas-estimate").setAttribute("aria-label", `Approximate cost of one swap: ${byId("gas-estimate").textContent}. ${referenceDetails}`);
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

  const CENTRE = 210, LABEL_RADIUS = 200, ROW_GAP = 42, HALF_WIDTH = 40, CLEARANCE = 186;
  // A label is always pushed at least this far off the vertical axis, so a pair
  // that straddles 12 or 6 o'clock lands in different columns instead of on top
  // of each other: per-side spacing alone never compares them.
  const MIN_OFFSET = HALF_WIDTH + 46, TOP_Y = 14, BOTTOM_Y = 414;
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
        node = svgElement("circle", { cx: CENTRE, cy: CENTRE, r: radius, fill: "none", "stroke-width": width, pathLength: 100, class: cls });
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

  /** Ticker and weight only. Targets live on the inner ring; the drift that
      matters is named in the centre, so a label never carries three lines. */
  function drawLabels(entries, targetMap, bandBps, funded) {
    const labels = byId("labels");
    labels.replaceChildren();
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) return;
    let offset = 0;
    const placed = [];
    for (const entry of entries) {
      const share = entry.weight / total * 100;
      const angle = ((offset + share / 2) / 100 * 360 - 90) * Math.PI / 180;
      placed.push({ ...entry, x: CENTRE + Math.cos(angle) * LABEL_RADIUS, y: CENTRE + Math.sin(angle) * LABEL_RADIUS });
      offset += share;
    }
    // Separate labels on each side when small holdings cluster together.
    for (const side of [placed.filter((p) => p.x < CENTRE), placed.filter((p) => p.x >= CENTRE)]) {
      if (!side.length) continue;
      side.sort((a, b) => a.y - b.y);
      for (let i = 1; i < side.length; i++) side[i].y = Math.max(side[i].y, side[i - 1].y + ROW_GAP);
      // If the spread stack leaves the canvas, lay it out rigidly around its own
      // centroid. Clamping one end instead would reopen a gap the pass just
      // closed, and shifting both ends in turn just oscillates.
      if (side[0].y < TOP_Y || side[side.length - 1].y > BOTTOM_Y) {
        const span = (side.length - 1) * ROW_GAP;
        const middle = side.reduce((sum, label) => sum + label.y, 0) / side.length;
        const start = Math.min(Math.max(middle - span / 2, TOP_Y), Math.max(TOP_Y, BOTTOM_Y - span));
        side.forEach((label, index) => { label.y = start + index * ROW_GAP; });
      }
    }
    for (const entry of placed) {
      // Push the whole two-line block clear of the ring, including after spacing.
      const top = entry.y - 12, bottom = entry.y + 42;
      const vertical = top > CENTRE ? top - CENTRE : bottom < CENTRE ? CENTRE - bottom : 0;
      const clear = vertical < CLEARANCE ? Math.sqrt(CLEARANCE ** 2 - vertical ** 2) + HALF_WIDTH : 0;
      const distance = Math.max(clear, MIN_OFFSET);
      let x = entry.x < CENTRE ? Math.min(entry.x, CENTRE - distance) : Math.max(entry.x, CENTRE + distance);
      x = Math.min(440, Math.max(-20, x));
      const target = Object.hasOwn(targetMap, entry.id) ? targetMap[entry.id] : null;
      const drift = funded && target !== null ? entry.weight - target : null;
      const group = svgElement("g", drift !== null && Math.abs(drift) > bandBps ? { class: "label-out" } : {});
      group.append(svgElement("text", { x, y: entry.y, class: "ticker", fill: color(entry.id) }, entry.id));
      group.append(svgElement("text", { x, y: entry.y + 18, class: "weight" }, `${percent.format(entry.weight / 100)}%`));
      labels.append(group);
    }
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
    // Drift is measured over every target, not only the assets currently held:
    // a target with no balance is dropped from `holdings` but still opens a
    // cycle in the engine, so ignoring it would claim "On target" while the
    // runner trades.
    let worst = 0, worstId = null;
    if (funded) for (const [id, target] of Object.entries(targetMap)) {
      const held = holdings.find((row) => row.id === id);
      const drift = (held ? held.weight : 0) - target;
      if (Math.abs(drift) > Math.abs(worst)) { worst = drift; worstId = id; }
    }

    // One status, in the middle. The summary line below is a disclosure
    // affordance only, so nothing is said twice in two places.
    let state = "No allocation", sub = "Set targets through your agent", value = "";
    const armed = snapshot?.armed === true;
    const drift = funded && band !== null
      ? worstId && Math.abs(worst) > band
        ? `${worstId} ${worst >= 0 ? "+" : "\u2212"}${percent.format(Math.abs(worst) / 100)}%`
        : `${percent.format(Math.abs(worst) / 100)}% off target`
      : null;
    if (funded) {
      const total = usdTotal(portfolio?.totalUsdE8);
      const observed = new Date(snapshot?.updatedAt);
      const at = Number.isFinite(observed.getTime()) ? time.format(observed) : null;
      value = [total, at ? `as of ${at}` : null].filter(Boolean).join(" · ");
    }
    if (failed) { state = funded ? "Last known" : "Unavailable"; sub = "Update unavailable"; }
    else if (receiptWait) {
      const plan = snapshot?.proposal;
      state = "Rebalancing";
      sub = plan?.sellAssetId && plan?.buyAssetId ? `${plan.sellAssetId} \u2192 ${plan.buyAssetId}` : "Swap in progress";
      // Mid-trade, how the send is going matters more than the portfolio total.
      value = receiptWait;
    } else if (funded) {
      state = band === null ? "Holdings" : !armed ? "Not armed" : Math.abs(worst) > band ? "Off target" : "On target";
      // "Not armed" is the headline, but the drift reading is not lost with it.
      sub = band === null ? "Drift band unavailable" : drift;
    } else if (targets.length) {
      state = "Targets";
      sub = portfolio ? positions.some((p) => positive(p.balance)) ? "Holdings below precision" : "Wallet empty" : "Holdings not checked";
    }
    byId("c-state").textContent = state;
    byId("c-sub").textContent = sub ?? "";
    byId("c-val").textContent = value;
    byId("c-legend").textContent = funded || !targets.length ? "" : "Targets only";
    byId("chart-title").textContent = state;

    drawRing(entries, "arcs", 150, 44, "arc", arcStore);
    drawRing(funded ? targets : [], "targets", 112, 5, "tgt", tgtStore);
    drawLabels(entries, targetMap, band === null ? Infinity : band, funded);

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

    const hash = shortHash(snapshot?.operation?.hash);
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

    byId("set-band").textContent = band === null ? "unavailable" : `\u00b1${percent.format(band / 100)}%`;
    const every = duration(snapshot?.config?.rebalanceIntervalSeconds);
    byId("set-every").textContent = every || "unavailable";
    const modes = { "private-key": "Local key", privy: "Privy", ledger: "Ledger" };
    byId("set-sign").textContent = modes[snapshot?.mode] || "unavailable";

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
  const summaryButton = byId("sum"), detailPanel = byId("panel");
  summaryButton.addEventListener("click", () => {
    const open = summaryButton.getAttribute("aria-expanded") === "true";
    summaryButton.setAttribute("aria-expanded", String(!open));
    detailPanel.classList.toggle("open", !open);
  });

  connect();
  void refreshGas();
})();
