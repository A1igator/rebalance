(() => {
  "use strict";
  const ns = "http://www.w3.org/2000/svg";
  const colors = { USDG: "#b4cbb8", AAPL: "#8dbafa", NVDA: "#bad776", MSFT: "#b5a1df", AMD: "#e3a37c" };
  const assetOrder = Object.keys(colors);
  function color(id) {
    let hash = 0;
    for (const letter of id) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) | 0;
    return colors[id] || `hsl(${(hash >>> 0) % 360} 55% 70%)`;
  }
  function svgElement(tag, attrs) {
    const element = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    return element;
  }

  // Dividers belong to a white SVG mask. Black straight strokes cut equal-width
  // parallel gaps without changing the colored allocation boundaries.
  function drawRing(segments, dividers, entries, radius, width, cx = 270, cy = 270) {
    segments.replaceChildren(); dividers.replaceChildren();
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    const innerRadius = radius - width / 2, outerRadius = radius + width / 2;
    let offset = 0;
    entries.forEach((entry, index) => {
      const share = entry.weight / total * 100;
      if (entries.length === 1) {
        segments.append(svgElement("circle", { cx, cy, r: radius, fill: "none", "stroke-width": width, stroke: color(entry.id) }));
      } else {
        // Solid sectors cannot wrap a dash past the closed-circle seam. Both
        // edges end at the allocation angle, including dominant and tiny slices.
        const start = offset / 100 * Math.PI * 2, end = (offset + share) / 100 * Math.PI * 2;
        const point = (r, angle) => `${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)}`;
        const large = share > 50 ? 1 : 0;
        segments.append(svgElement("path", {
          d: `M ${point(outerRadius, start)} A ${outerRadius} ${outerRadius} 0 ${large} 1 ${point(outerRadius, end)} ` +
            `L ${point(innerRadius, end)} A ${innerRadius} ${innerRadius} 0 ${large} 0 ${point(innerRadius, start)} Z`,
          fill: color(entry.id),
        }));
      }
      if (entries.length > 1) {
        const previousShare = entries[(index + entries.length - 1) % entries.length].weight / total * 100;
        // Limit the two neighboring cuts to at most half of a tiny slice.
        const gap = Math.min(4, 2 * innerRadius * Math.sin(Math.min(previousShare, share) * Math.PI / 200));
        const angle = offset / 100 * Math.PI * 2;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        dividers.append(svgElement("line", {
          x1: cx + cos * (innerRadius - 2), y1: cy + sin * (innerRadius - 2),
          x2: cx + cos * (outerRadius + 2), y2: cy + sin * (outerRadius + 2),
          stroke: "black", "stroke-width": gap, "stroke-linecap": "butt",
        }));
      }
      offset += share;
    });
  }
  window.rebalanceRing = { colors, assetOrder, color, drawRing };
})();
