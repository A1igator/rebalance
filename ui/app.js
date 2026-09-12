(() => {
  "use strict";
  const ns = "http://www.w3.org/2000/svg";
  const byId = (id) => document.getElementById(id);
  // Carry a valid view handle back to the selector; anything else goes to the root.
  const viewToken = /^#view=([a-f0-9]{64})$/i.exec(window.location?.hash || "")?.[1];
  byId("portfolios-back")?.setAttribute("href", viewToken ? `/#view=${viewToken}` : "/");
  const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  // One palette for the whole app: the selector tiles and this chart must never
  // disagree about what colour an asset is.
  const { assetOrder, color } = window.rebalanceRing;
  let lastSnapshot = null;
  function positive(value) {
    try { return BigInt(value) > 0n; } catch { return false; }
  }
  function unsigned(value) {
    return typeof value === "string" && /^\d{1,78}$/.test(value) ? BigInt(value) : null;
  }
  function feeDollars(value) {
    const amount = unsigned(value);
    if (amount === null) return null;
    const fraction = (amount % 100000000n).toString().padStart(8, "0").replace(/0+$/, "").padEnd(2, "0");
    return `$${amount / 100000000n}.${fraction}`;
  }
  function gwei(wei) {
    const place = 10n ** 7n;
    if (wei > 0n && wei * 2n < place) return "<0.01";
    const hundredths = (wei + place / 2n) / place;
    return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
  }
  function feeState(snapshot) {
    if (!snapshot?.armed || snapshot.operation?.status !== "fee-target") return null;
    const check = snapshot.feeCheck, target = unsigned(snapshot.config?.rebalanceFeeTargetUsdE8);
    const estimate = unsigned(check?.estimatedUsdE8), gas = unsigned(check?.gasPriceWei), eth = unsigned(check?.ethUsdE8);
    const at = typeof check?.observedAt === "string" ? Date.parse(check.observedAt) : NaN;
    if (target !== null && target === unsigned(check?.targetUsdE8) && check?.state === "above-target" &&
        estimate !== null && estimate > target && gas !== null && gas > 0n && eth !== null && eth > 0n &&
        Number.isFinite(at) && at <= Date.now() && Date.now() - at < 90000) {
      return { state: "Gas above target", sub: `≈${feeDollars(check.estimatedUsdE8)} · target ${feeDollars(check.targetUsdE8)}`, value: `${gwei(gas)} gwei` };
    }
    return { state: "Fee estimate unavailable", sub: "Waiting for a fresh estimate", value: "" };
  }
  function rows(values) {
    return values.filter(({ weight }) => Number.isInteger(weight) && weight > 0 && weight <= 10000).sort((a, b) => {
      const left = assetOrder.indexOf(a.id), right = assetOrder.indexOf(b.id);
      if (left < 0 && right < 0) return a.id.localeCompare(b.id);
      return (left < 0 ? assetOrder.length : left) - (right < 0 ? assetOrder.length : right);
    });
  }
  function svgElement(tag, attrs, content) {
    const element = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (content !== undefined) element.textContent = content;
    return element;
  }

  const CENTRE = 210, LABEL_RADIUS = 200, ROW_GAP = 42, HALF_WIDTH = 40, HALF_HEIGHT = 16.5, CLEARANCE = 186;
  const LABEL_MIN_Y = -3.5, LABEL_MAX_Y = 443.5;
  const arcStore = new Map(), tgtStore = new Map(), labelStore = new Map();
  function ringPath(radius, width, start, sweep, startGap, endGap) {
    const inner = radius - width / 2, outer = radius + width / 2;
    const point = (r, angle) => `${CENTRE + r * Math.cos(angle)} ${CENTRE + r * Math.sin(angle)}`;
    if (sweep >= Math.PI * 2) {
      return `M ${point(outer, 0)} A ${outer} ${outer} 0 1 1 ${point(outer, Math.PI)} ` +
        `A ${outer} ${outer} 0 1 1 ${point(outer, 0)} L ${point(inner, 0)} ` +
        `A ${inner} ${inner} 0 1 0 ${point(inner, Math.PI)} A ${inner} ${inner} 0 1 0 ${point(inner, 0)} Z`;
    }
    // Each cut is parallel to the true allocation boundary and displaced by
    // half its gap. Circle intersections, rather than equal angular insets,
    // keep the two neighboring edges parallel across the entire ring width.
    const outerStart = start + Math.asin(startGap / outer), outerEnd = start + sweep - Math.asin(endGap / outer);
    const innerStart = start + Math.asin(startGap / inner), innerEnd = start + sweep - Math.asin(endGap / inner);
    return `M ${point(outer, outerStart)} A ${outer} ${outer} 0 ${outerEnd - outerStart > Math.PI ? 1 : 0} 1 ${point(outer, outerEnd)} ` +
      `L ${point(inner, innerEnd)} A ${inner} ${inner} 0 ${innerEnd - innerStart > Math.PI ? 1 : 0} 0 ${point(inner, innerStart)} Z`;
  }
  function removeStored(store, seen) {
    for (const [id, node] of store) if (!seen.has(id)) {
      if (window.rebalanceStockLinks) window.rebalanceStockLinks.remove(node); else node.remove();
      store.delete(id);
    }
  }
  function drawRing(entries, container, radius, width, cls, store) {
    const parent = byId(container);
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    const seen = new Set();
    const sweeps = entries.map(entry => entry.weight / total * Math.PI * 2);
    const inner = radius - width / 2;
    // Both segments share each boundary's width. Cap small-slice cuts so at
    // least half of their angular span remains visible at the inner edge.
    const gaps = sweeps.map((sweep, i) => entries.length === 1 ? 0
      : Math.min(2, inner * Math.sin(Math.min(sweep, sweeps[(i + sweeps.length - 1) % sweeps.length]) / 4)));
    let offset = 0;
    entries.forEach((entry, index) => {
      let node = store.get(entry.id);
      if (!node) { node = svgElement("path", { class: cls }); store.set(entry.id, node); }
      node.setAttribute("data-asset", entry.id);
      node.setAttribute("fill", color(entry.id));
      node.setAttribute("d", ringPath(radius, width, offset, sweeps[index], gaps[index], gaps[(index + 1) % gaps.length]));
      const linked = window.rebalanceStockLinks?.wrap(node, entry.id, cls === "arc" ? "actual" : "target") || node;
      if (linked.parentNode !== parent) parent.append(linked);
      seen.add(entry.id);
      offset += sweeps[index];
    });
    removeStored(store, seen);
  }

  const modelNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

  /** The saved risk model no longer has a caption of its own on screen; this
      keeps describing it in the chart's accessible description. */
  function renderRisk(snapshot, disconnected) {
    const summary = snapshot?.config?.allocation;
    const hasTargets = snapshot?.config?.targets && Object.keys(snapshot.config.targets).length > 0;
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
      detail = `Saved target allocation model, calculated ${summary.computedAt}. User-selected target risk ${summary.subjectiveRiskScore} points on a 0 to 100 scale over ${months} months, not a probability of loss. ` +
        `Expected total return assumption ${modelNumber.format(summary.expectedReturnBps / 100)}%, benchmark ${modelNumber.format(summary.benchmarkReturnBps / 100)}% over that same horizon. ` +
        `Return/risk ${summary.score}: expected horizon excess return in basis points per user risk point. This custom ratio is not standard Sharpe. These describe target weights, not the current holdings or a realized return.`;
    } else if (metadata && summary.objective === "sharpe" && summary.returnBasis === "history-period" &&
        ["daily", "weekly", "monthly"].includes(summary.history?.interval) &&
        ["tradable-token", "underlying-proxy"].includes(summary.history?.basis) && date(summary.history?.asOf) &&
        typeof summary.history?.quoteCurrency === "string" && /^[A-Z][A-Z0-9_-]{0,15}$/.test(summary.history.quoteCurrency)) {
      detail = `Saved target allocation model, calculated ${summary.computedAt}. Historical Sharpe ${summary.score}, using ${summary.history.interval} differential returns; not annualized. ` +
        `Historical data as of ${summary.history.asOf}, ${summary.history.basis === "underlying-proxy" ? "underlying-asset proxy" : "tradable-token"} basis in ${summary.history.quoteCurrency}. ` +
        `Historical mean return ${modelNumber.format(summary.expectedReturnBps / 100)}% per observation. Standard Sharpe divides historical mean excess return by its sample standard deviation. ` +
        "These describe target weights with constant weights per observation and no execution costs, not current holdings or a future return guarantee.";
    }
    if (disconnected) {
      detail = `Connection unavailable. Last saved model only. ${detail}`;
    }
    return detail;
  }

  const usdFormat = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  function usdTotal(value) {
    const amount = unsigned(value);
    return amount === null ? null : usdFormat.format(Number(amount / 1000000n) / 100);
  }
  function duration(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
    if (seconds % 3600 === 0) { const hours = seconds / 3600; return `${hours} ${hours === 1 ? "hour" : "hours"}`; }
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds}s`;
  }

  // Match the planner's rational USD comparison. Apportioned display weights
  // can round an actual breach back onto the boundary.
  function driftOf(portfolio, targets, band) {
    const total = unsigned(portfolio?.totalUsdE8), entries = Object.entries(targets);
    if (total === null || total <= 0n || band === null || !entries.length ||
        entries.some(([, weight]) => !Number.isInteger(weight) || weight < 0 || weight > 10000) ||
        entries.reduce((sum, [, weight]) => sum + weight, 0) !== 10000) return null;
    const values = new Map();
    for (const position of portfolio.positions) {
      const id = position.id || position.symbol, value = unsigned(position.valueUsdE8);
      if (!Object.hasOwn(targets, id) || values.has(id) || value === null) return null;
      values.set(id, value);
    }
    if (values.size !== entries.length || [...values.values()].reduce((sum, value) => sum + value, 0n) !== total) return null;
    const magnitude = (value) => value < 0n ? -value : value;
    const result = { total, worst: 0n, worstId: null, outside: new Set() };
    for (const [id, target] of entries) {
      const delta = values.get(id) * 10000n - total * BigInt(target);
      if (magnitude(delta) > magnitude(result.worst)) { result.worst = delta; result.worstId = id; }
      if (magnitude(delta) > total * BigInt(band)) result.outside.add(id);
    }
    return result;
  }

  function ledgerState(snapshot) {
    if (snapshot?.mode !== "ledger" || snapshot.armed !== true) return null;
    const operation = snapshot.operation, status = operation?.status;
    const saved = snapshot.ledgerRequest;
    const request = saved?.chainId === 4663 && typeof saved.wallet === "string" &&
      saved.wallet.toLowerCase() === snapshot.wallet?.toLowerCase() ? saved : null;
    const needed = status === "waiting-ledger" || Boolean(snapshot.proposal);
    const prompt = snapshot.ledgerPrompt;
    let outcome = status?.startsWith("ledger-") ? status.slice(7)
      : request?.state === "finished" && needed ? request.outcome : null;
    if (request && ["requested", "consumed"].includes(request.state)) {
      const deadline = request.state === "requested" ? request.queueExpiresAt : request.expiresAt;
      if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) outcome = "expired";
      else return request.state === "requested"
        ? { state: "Preparing rebalance", sub: "Queued for a fresh check" }
        : { state: "Ledger signing", sub: "Physical confirmation required" };
    }
    const ended = { rejected: "Request rejected", cancelled: "Request cancelled", timeout: "Request timed out", expired: "Request expired",
      "device-changed": "Device changed", "runner-restarted": "Request ended", invalidated: "Request ended", "cycle-invalidated": "Request ended" }[outcome];
    if (ended) return { state: ended, sub: "Reconnect Ledger to retry" };
    if (prompt?.suspended && needed) return { state: "Ledger needs attention", sub: "Reconnect Ledger after resolving the issue" };
    if (needed) return prompt?.connected
      ? { state: "Preparing rebalance", sub: "Device prompts open automatically" }
      : { state: "Ledger needed", sub: "Connect and unlock Ledger" };
    return null;
  }

  /** Labels begin on their visible segment's midpoint ray. Only collisions
      move them off that ray; a leader then preserves the segment association. */
  function drawLabels(entries, outside) {
    const labels = byId("labels"), seen = new Set();
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) { removeStored(labelStore, seen); return; }
    let offset = 0;
    const placed = entries.map(entry => {
      const sweep = entry.weight / total * Math.PI * 2;
      const angle = offset + sweep / 2 - Math.PI / 2;
      offset += sweep;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      // Find the nearest point on this ray where the real two-line text box
      // clears the ring. A blanket horizontal shove mislabels top/bottom slices.
      let low = LABEL_RADIUS, high = 270;
      for (let step = 0; step < 32; step++) {
        const radius = (low + high) / 2;
        const clearance = Math.hypot(Math.max(0, Math.abs(cos * radius) - HALF_WIDTH), Math.max(0, Math.abs(sin * radius) - HALF_HEIGHT));
        if (clearance < CLEARANCE) low = radius; else high = radius;
      }
      const x = CENTRE + cos * high, y = CENTRE + sin * high;
      return { ...entry, angle, x, y, idealX: x, idealY: y, side: cos < 0 ? -1 : 1 };
    });
    // Pool only overlapping neighbors, minimizing displacement rather than
    // pushing an entire side into a stack because one label touches an edge.
    for (const side of [-1, 1]) {
      const members = placed.filter(entry => entry.side === side).sort((a, b) => a.y - b.y);
      const blocks = [];
      members.forEach((entry, index) => {
        blocks.push({ start: index, count: 1, sum: entry.y - index * ROW_GAP });
        while (blocks.length > 1) {
          const right = blocks.at(-1), left = blocks.at(-2);
          if (left.sum / left.count <= right.sum / right.count) break;
          blocks.splice(-2, 2, { start: left.start, count: left.count + right.count, sum: left.sum + right.sum });
        }
      });
      for (const block of blocks) {
        const mean = Math.max(LABEL_MIN_Y, Math.min(LABEL_MAX_Y - (members.length - 1) * ROW_GAP, block.sum / block.count));
        for (let index = block.start; index < block.start + block.count; index++) members[index].y = mean + index * ROW_GAP;
      }
    }
    for (const entry of placed) {
      const vertical = Math.max(0, Math.abs(entry.y - CENTRE) - HALF_HEIGHT);
      const required = vertical < CLEARANCE ? Math.sqrt(CLEARANCE ** 2 - vertical ** 2) + HALF_WIDTH : 0;
      entry.x = CENTRE + entry.side * Math.max(Math.abs(entry.x - CENTRE), required);
    }
    // Labels across twelve/six o'clock may share a row. Separate only those
    // actual text boxes, not every label near the vertical axis.
    for (const left of placed.filter(entry => entry.side < 0)) {
      for (const right of placed.filter(entry => entry.side > 0)) {
        if (Math.abs(left.y - right.y) < ROW_GAP && right.x - left.x < HALF_WIDTH * 2 + 8) {
          left.x = Math.min(left.x, CENTRE - HALF_WIDTH - 4);
          right.x = Math.max(right.x, CENTRE + HALF_WIDTH + 4);
        }
      }
    }
    const point = (radius, angle) => `${CENTRE + radius * Math.cos(angle)} ${CENTRE + radius * Math.sin(angle)}`;
    for (const entry of placed) {
      let group = labelStore.get(entry.id);
      if (!group) {
        group = svgElement("g", {});
        group.append(svgElement("text", { class: "ticker", fill: color(entry.id) }, entry.id));
        group.append(svgElement("text", { class: "weight" }));
        group.append(svgElement("path", { class: "label-leader", stroke: color(entry.id), "aria-hidden": "true" }));
        labelStore.set(entry.id, group);
      }
      group.setAttribute("class", outside?.has(entry.id) ? "label-out" : "");
      group.setAttribute("data-asset", entry.id);
      const [ticker, weight, leader] = group.children;
      const baseline = entry.y - 4.5;
      ticker.setAttribute("x", entry.x); ticker.setAttribute("y", baseline);
      weight.setAttribute("x", entry.x); weight.setAttribute("y", baseline + 18);
      weight.textContent = `${percent.format(entry.weight / 100)}%`;
      const labelAngle = Math.atan2(entry.y - CENTRE, entry.x - CENTRE);
      const distance = Math.hypot(entry.x - CENTRE, entry.y - CENTRE);
      const edge = Math.min((HALF_WIDTH + 3) / Math.abs(Math.cos(labelAngle)), (HALF_HEIGHT + 3) / Math.abs(Math.sin(labelAngle)));
      const turn = Math.atan2(Math.sin(labelAngle - entry.angle), Math.cos(labelAngle - entry.angle));
      leader.setAttribute("d", `M ${point(174, entry.angle)} L ${point(180, entry.angle)} A 180 180 0 0 ${turn >= 0 ? 1 : 0} ${point(180, labelAngle)} L ${point(distance - edge, labelAngle)}`);
      leader.setAttribute("visibility", Math.hypot(entry.x - entry.idealX, entry.y - entry.idealY) > 1 ? "visible" : "hidden");
      const linked = window.rebalanceStockLinks?.wrap(group, entry.id, "label") || group;
      if (linked.parentNode !== labels) labels.append(linked);
      seen.add(entry.id);
    }
    removeStored(labelStore, seen);
  }

  function render(snapshot, disconnected = false) {
    const portfolio = snapshot?.portfolio;
    const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
    const holdings = rows(positions.map((p) => ({ id: String(p.id || p.symbol), weight: p.weightBps })));
    const targetMap = snapshot?.config?.targets || {};
    const targets = rows(Object.entries(targetMap).map(([id, weight]) => ({ id, weight })));
    const funded = positive(portfolio?.totalUsdE8) && holdings.length > 0;
    const error = typeof snapshot?.error === "string" ? snapshot.error.slice(0, 400).trim()
      : snapshot?.error ? "Update unavailable" : "";
    const trace = Array.isArray(snapshot?.graph?.trace) ? snapshot.graph.trace : [];
    const phase = trace.filter(node => node !== "error").at(-1) || snapshot?.graph?.node;
    const rebalanceFailed = ["quote", "execute"].includes(phase);
    const receiptWait = { pending: "Waiting for receipt", unresolved: "Transaction unresolved", confirming: "Confirming transaction", "recovery-wait": "Automatic recovery waiting", "recovery-busy": "Recovery in progress" }[snapshot?.operation?.status];
    const entries = funded ? holdings : targets;
    const bandRaw = snapshot?.config?.driftThresholdBps;
    const band = Number.isInteger(bandRaw) && bandRaw >= 0 && bandRaw <= 10000 ? bandRaw : null;
    const deviation = funded ? driftOf(portfolio, targetMap, band) : null;
    const outside = deviation?.outside.size > 0;
    // Conversion is display-only; the threshold and label flags stay exact.
    const worst = deviation ? Number(deviation.worst) / Number(deviation.total) : 0;
    const ledger = ledgerState(snapshot);
    const fee = feeState(snapshot);
    const reverted = snapshot?.operation?.status === "reverted";
    const kind = snapshot?.operation?.kind;
    const transaction = kind === "approval" ? "Approval" : kind === "swap" ? "Swap" : "Transaction";

    // Execution and drift share the centre; settings remain in the disclosure.
    let state = "No allocation", sub = "Set targets through your agent", value = "";
    const armed = snapshot?.armed === true;
    const drift = deviation
      ? outside
        ? `${deviation.worstId} ${worst >= 0 ? "+" : "\u2212"}${percent.format(Math.abs(worst) / 100)}%`
        : `${percent.format(Math.abs(worst) / 100)}% off target`
      : null;
    if (funded) {
      const total = usdTotal(portfolio?.totalUsdE8);
      const observed = new Date(snapshot?.updatedAt);
      const at = Number.isFinite(observed.getTime()) ? time.format(observed) : null;
      value = [total, at ? `as of ${at}` : null].filter(Boolean).join(" · ");
    }
    if (disconnected) { state = funded ? "Last known" : "Unavailable"; sub = "Connection unavailable"; }
    else if (error) {
      state = rebalanceFailed ? "Rebalance failed" : funded ? "Last known" : "Unavailable";
      sub = error; value = "";
    } else if (reverted) {
      state = "Transaction reverted";
      sub = "Receipt recovery required";
    } else if (receiptWait) {
      const plan = snapshot?.proposal;
      state = kind === "approval" ? "Approval pending" : "Rebalancing";
      sub = kind === "approval" ? "Token spending approval"
        : plan?.sellAssetId && plan?.buyAssetId ? `${plan.sellAssetId} \u2192 ${plan.buyAssetId}` : `${transaction} in progress`;
      // Mid-trade, how the send is going matters more than the portfolio total.
      value = receiptWait;
    } else if (snapshot?.operation?.status === "configuration-changed") {
      state = "Updating settings…"; sub = "Checking the current allocation"; value = "";
    } else if (armed && snapshot?.operation?.status === "cooling-down") {
      state = "Cooling down";
      const eligible = new Date(snapshot?.cycle?.nextEligibleAt);
      sub = Number.isFinite(eligible.getTime()) && eligible.getTime() > Date.now()
        ? `Next cycle after ${time.format(eligible)}` : "Waiting for the next cycle";
    } else if (fee) {
      state = fee.state; sub = fee.sub; value = fee.value;
    } else if (ledger) {
      state = ledger.state; sub = ledger.sub;
    } else if (armed && ["quote", "execute"].includes(snapshot?.graph?.node)) {
      state = "Rebalancing";
      sub = snapshot.graph.node === "quote" ? "Preparing a fresh quote" : "Preparing the transaction";
    } else if (funded) {
      state = !armed ? "Paused" : !deviation ? "Holdings" : outside ? "Off target" : "On target";
      // A stopped runner is the headline, in the word people use for it,
      // and the drift reading is not lost underneath it.
      sub = band === null ? "Drift band unavailable" : deviation ? drift : "Exact drift unavailable";
    } else if (targets.length) {
      state = "Target allocation";
      sub = portfolio ? positions.some((p) => positive(p.balance)) ? "Holdings below precision" : "Wallet empty" : "Holdings not checked";
    }
    // A target ring still needs a clear label when an error or transaction
    // takes priority in the center. Keep its status explanation intact.
    if (!funded && targets.length && state !== "Target allocation") {
      value = [value, "Target allocation"].filter(Boolean).join(" · ");
    }
    byId("c-state").textContent = state;
    byId("c-state").classList.toggle("compact", state.length > 18);
    byId("c-sub").textContent = sub ?? "";
    byId("c-sub").setAttribute("title", sub ?? "");
    byId("c-val").textContent = value;
    byId("chart-title").textContent = state;

    if (window.rebalanceStockLinks?.setOffset) {
      const assigned = new Set();
      for (const candidates of [entries, targets]) {
        const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
        let offset = 0;
        for (const entry of candidates) {
          const sweep = entry.weight / total * Math.PI * 2;
          if (!assigned.has(entry.id)) {
            const angle = offset + sweep / 2 - Math.PI / 2;
            window.rebalanceStockLinks.setOffset(entry.id, 14 * Math.cos(angle), 14 * Math.sin(angle));
            assigned.add(entry.id);
          }
          offset += sweep;
        }
      }
    }
    drawRing(entries, "arcs", 150, 44, "arc", arcStore);
    drawRing(funded ? targets : [], "targets", 112, 5, "tgt", tgtStore);
    drawLabels(entries, deviation?.outside);

    // Motion reports settlement: an unconfirmed swap gets a ghost, never a moved arc.
    const moving = receiptWait && kind === "swap" ? snapshot?.proposal?.sellAssetId : null;
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

    byId("set-band").textContent = band === null ? "Unavailable" : `\u00b1${percent.format(band / 100)}%`;
    const every = duration(snapshot?.config?.rebalanceIntervalSeconds);
    byId("set-every").textContent = every || "Unavailable";
    const configuredFee = snapshot?.config?.rebalanceFeeTargetUsdE8;
    const feeTarget = configuredFee === undefined ? "Not set" : feeDollars(configuredFee) || "Unavailable";
    byId("set-fee-target").textContent = feeTarget;

    let allocationDescription = `${state}. ${sub}.${value ? ` ${value}.` : ""} ${funded ? "Outer ring, actual holdings" : "Ring weights"}: ${entries.map((r) => `${r.id} ${percent.format(r.weight / 100)}%`).join(", ")}.${funded && targets.length ? ` Inner ring, targets: ${targets.map((r) => `${r.id} ${percent.format(r.weight / 100)}%`).join(", ")}.` : ""}`;
    allocationDescription += ` ${renderRisk(snapshot, disconnected)}`;
    byId("chart-description").textContent = `${allocationDescription} Rebalance trigger: ${byId("set-band").textContent}. Cycle interval: ${every || "unavailable"}. Target rebalance fee: ${feeTarget}. ETH is excluded from allocation.`;
  }

  let stream = null;
  let streamReady = false;
  let refreshTimer = null;
  let initialTimer = null;
  let feeExpiryTimer = null;
  let controller = null;
  let refreshing = false;
  let suspended = document.visibilityState === "hidden", pageHidden = false;
  let lastRendered = null;
  let streamGeneration = 0;

  function show(snapshot, disconnected = false) {
    // Controls must regain freshness after browser restoration even when the chart pixels are unchanged.
    window.rebalanceControls?.updateStatus(snapshot, disconnected);
    window.rebalanceShare?.update(snapshot, disconnected);
    clearTimeout(feeExpiryTimer); feeExpiryTimer = null;
    const feeAt = Date.parse(snapshot?.feeCheck?.observedAt ?? "");
    if (!disconnected && snapshot?.armed && snapshot.operation?.status === "fee-target" && Number.isFinite(feeAt) && feeAt <= Date.now() && feeAt + 90000 > Date.now()) {
      feeExpiryTimer = setTimeout(() => {
        feeExpiryTimer = null;
        if (!suspended && lastSnapshot === snapshot) { lastRendered = null; render(snapshot); }
      }, feeAt + 90000 - Date.now());
    }
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
      if (!streamReady && !suspended && generation === streamGeneration) {
        accept(snapshot);
        if (window.rebalanceControls) await window.rebalanceControls.refreshRunner(snapshot.wallet);
      }
    } catch {
      if (!streamReady && !suspended && generation === streamGeneration) show(lastSnapshot, true);
    } finally {
      clearTimeout(timeout);
      if (controller === request) { controller = null; refreshing = false; }
      if (!streamReady && !suspended && generation === streamGeneration && !refreshing) refreshTimer = setTimeout(refresh, 5000);
    }
  }

  function fallback() {
    if (!refreshTimer && !refreshing && !suspended) void refresh();
  }

  function connect() {
    if (suspended || stream) return;
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
      source.addEventListener("runner", (event) => {
        if (stream !== source || suspended) return;
        try { window.rebalanceControls?.updateRunner(JSON.parse(event.data)); }
        catch { window.rebalanceControls?.updateRunner(null, true); }
      });
      // EventSource reconnects itself; polling runs only until a valid event.
      source.onerror = () => {
        if (stream !== source || suspended) return;
        streamReady = false;
        window.rebalanceControls?.updateRunner(null, true);
        fallback();
      };
    } catch { fallback(); }
  }

  function suspend() {
    if (suspended) return;
    suspended = true; streamReady = false; streamGeneration++;
    stream?.close(); stream = null;
    clearTimeout(initialTimer); initialTimer = null;
    clearTimeout(refreshTimer); refreshTimer = null;
    clearTimeout(feeExpiryTimer); feeExpiryTimer = null;
    controller?.abort(); controller = null; refreshing = false;
    window.rebalanceControls?.updateStatus(lastSnapshot, true);
    window.rebalanceShare?.update(lastSnapshot, true);
    window.rebalanceControls?.updateRunner(null, true);
  }
  function resume() {
    if (!suspended || pageHidden || document.visibilityState === "hidden") return;
    suspended = false; lastRendered = null; connect();
  }
  window.addEventListener("pagehide", () => { pageHidden = true; suspend(); });
  window.addEventListener("pageshow", () => { pageHidden = false; resume(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") suspend(); else resume();
  });
  const settingsToggle = byId("settings-toggle"), settingsPanel = byId("settings-panel");
  settingsToggle.addEventListener("click", () => {
    const open = settingsToggle.getAttribute("aria-expanded") !== "true";
    settingsToggle.setAttribute("aria-expanded", String(open));
    settingsPanel.setAttribute("aria-hidden", String(!open));
    if (open) settingsPanel.removeAttribute("inert"); else settingsPanel.setAttribute("inert", "");
    settingsPanel.classList.toggle("open", open);
  });

  connect();
})();
