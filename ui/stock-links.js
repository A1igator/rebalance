(() => {
  "use strict";
  const ns = "http://www.w3.org/2000/svg";
  // Queries contain this public manifest only, never wallet or conversation data.
  const assetIds = new Set(["USDG", "TSLA", "AAPL", "NVDA", "AMZN", "RUN", "MRNA", "MSFT", "AMD"]);
  const kinds = { actual: "actual allocation", target: "target allocation", label: "allocation label" };
  const wrappers = new WeakMap(), groups = new Map(), offsets = new Map();

  function update(assetId) {
    const records = groups.get(assetId);
    if (!records) return;
    const highlighted = [...records].some(record => record.hovered || record.focused);
    const { x, y } = offsets.get(assetId) || { x: 0, y: 0 };
    for (const record of records) {
      // Ring parents rotate -90deg; labels already use chart coordinates.
      const dx = record.kind === "label" ? x : -y;
      const dy = record.kind === "label" ? y : x;
      record.link.setAttribute("class", `stock-link stock-link--${record.kind}${highlighted ? " is-highlighted" : ""}`);
      record.link.setAttribute("style", `--stock-offset-x:${dx}px;--stock-offset-y:${dy}px`);
    }
  }
  function setOffset(assetId, x, y) {
    if (!assetIds.has(assetId) || !Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) > 20) return;
    offsets.set(assetId, { x, y });
    update(assetId);
  }
  function detach(record) {
    const records = groups.get(record.assetId);
    records?.delete(record);
    if (records?.size === 0) groups.delete(record.assetId);
    record.link.remove(); record.node.remove(); record.hit?.remove(); record.visual.remove();
    wrappers.delete(record.node);
    update(record.assetId);
  }
  function refresh(node) {
    const record = wrappers.get(node);
    if (!record) return;
    // The untranslated hit area remains under a still pointer when the visible
    // segment moves out. This prevents hover/leave oscillation on thin targets.
    const hit = node.cloneNode(true);
    hit.setAttribute("class", "stock-link__hit");
    hit.setAttribute("aria-hidden", "true");
    hit.setAttribute("tabindex", "-1");
    hit.setAttribute("focusable", "false");
    record.hit?.remove();
    record.hit = hit;
    record.link.append(hit);
  }
  function wrap(node, assetId, kind) {
    const previous = wrappers.get(node);
    if (!assetIds.has(assetId) || !Object.hasOwn(kinds, kind)) {
      if (previous) detach(previous);
      return node;
    }
    if (previous && (previous.assetId !== assetId || previous.kind !== kind)) detach(previous);
    let record = wrappers.get(node);
    if (!record) {
      const link = document.createElementNS(ns, "a");
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      link.setAttribute("referrerpolicy", "no-referrer");
      link.setAttribute("tabindex", "0");
      link.setAttribute("data-stock-asset", assetId);
      const search = `${assetId} ${assetId === "USDG" ? "stablecoin" : "stock"} chart`;
      link.setAttribute("href", `https://www.google.com/search?q=${encodeURIComponent(search)}`);
      link.setAttribute("aria-label", `${search} on Google, ${kinds[kind]} (opens in a new tab)`);
      const visual = document.createElementNS(ns, "g");
      visual.setAttribute("class", "stock-link__visual");
      visual.append(node); link.append(visual);
      record = { node, link, visual, hit: null, assetId, kind, hovered: false, focused: false };
      wrappers.set(node, record);
      if (!groups.has(assetId)) groups.set(assetId, new Set());
      groups.get(assetId).add(record);
      link.addEventListener("pointerenter", () => { record.hovered = true; update(assetId); });
      link.addEventListener("pointerleave", () => { record.hovered = false; update(assetId); });
      link.addEventListener("focusin", () => { record.focused = true; update(assetId); });
      link.addEventListener("focusout", () => { record.focused = false; update(assetId); });
    }
    refresh(node);
    update(assetId);
    return record.link;
  }
  function remove(node) {
    const record = wrappers.get(node);
    if (record) detach(record); else node.remove();
  }
  window.rebalanceStockLinks = Object.freeze({ wrap, remove, refresh, setOffset });
})();
