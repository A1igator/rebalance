(() => {
  "use strict";
  const ns = "http://www.w3.org/2000/svg";
  const byId = (id) => document.getElementById(id);
  const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const colors = { USDG: "#b4cbb8", AAPL: "#8dbafa", NVDA: "#bad776", MSFT: "#b5a1df", AMD: "#e3a37c" };
  let lastSnapshot = null;

  function positive(value) {
    try { return BigInt(value) > 0n; } catch { return false; }
  }
  function rows(values) {
    return values.filter(({ weight }) => Number.isInteger(weight) && weight > 0 && weight <= 10000);
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
    const state = funded ? failed || receiptWait ? "Last known holdings" : "Current holdings" : targets.length ? "Targets" : "No allocation";
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
    byId("chart-title").textContent = state;
    byId("chart-description").textContent = `${note}. ${entries.map((r) => `${r.id} ${percent.format(r.weight / 100)}%`).join(", ")}`;
    const segments = byId("segments");
    const labels = byId("labels");
    segments.replaceChildren(); labels.replaceChildren();
    let offset = 0;
    const placed = [];
    for (const entry of entries) {
      const share = entry.weight / total * 100;
      const gap = entries.length > 1 ? Math.min(0.5, share / 4) : 0;
      segments.append(svgElement("circle", {
        cx: 270, cy: 270, r: 164, fill: "none", "stroke-width": 78, pathLength: 100,
        stroke: color(entry.id), "stroke-dasharray": `${share - gap} ${100 - share + gap}`, "stroke-dashoffset": -offset,
      }));
      const angle = ((offset + share / 2) / 100 * 360 - 90) * Math.PI / 180;
      placed.push({ ...entry, x: 270 + Math.cos(angle) * 235, y: 270 + Math.sin(angle) * 235 });
      offset += share;
    }
    // Separate labels on each side when small holdings cluster together.
    for (const side of [placed.filter((p) => p.x < 270), placed.filter((p) => p.x >= 270)]) {
      side.sort((a, b) => a.y - b.y);
      for (let i = 1; i < side.length; i++) side[i].y = Math.max(side[i].y, side[i - 1].y + 38);
      if (side.length) {
        side[side.length - 1].y = Math.min(490, side[side.length - 1].y);
        for (let i = side.length - 2; i >= 0; i--) side[i].y = Math.min(side[i].y, side[i + 1].y - 38);
      }
    }
    for (const entry of placed) {
      const x = Math.min(485, Math.max(55, entry.x));
      labels.append(svgElement("text", { x, y: entry.y, class: "ticker" }, entry.id));
      labels.append(svgElement("text", { x, y: entry.y + 20, class: "weight" }, `${percent.format(entry.weight / 100)}%`));
    }
  }

  async function refresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch("/api/status", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Local status unavailable");
      const snapshot = await response.json();
      if (snapshot?.app !== "Rebalance") throw new Error("Invalid local status");
      lastSnapshot = snapshot;
      render(snapshot);
    } catch {
      render(lastSnapshot, true);
    } finally {
      clearTimeout(timeout);
      setTimeout(refresh, 5000);
    }
  }
  refresh();
})();
