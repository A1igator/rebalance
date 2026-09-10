(() => {
  "use strict";
  const token = /^#view=([a-f0-9]{64})$/i.exec(window.location.hash)?.[1] || null;
  const fragment = token ? `#view=${token}` : "";
  const subscribers = new Set();
  let latest = null, controller = null, retryTimer = null, suspended = false, generation = 0;
  function chartUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      if (!["http:", "https:"].includes(url.protocol) || url.protocol !== window.location.protocol ||
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password ||
          url.pathname !== "/chart" || url.search || url.hash) return null;
      return `${url.href}${fragment}`;
    } catch { return null; }
  }
  function emit(update) { for (const subscriber of subscribers) subscriber(update); }
  function accept(value) {
    if (!value || typeof value.canSetup !== "boolean" || !Array.isArray(value.portfolios) ||
        (value.connectedWallet !== null && (typeof value.connectedWallet !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.connectedWallet))) ||
        (value.chartUrl !== null && !chartUrl(value.chartUrl))) throw new Error("View update unavailable.");
    const changed = latest !== null && latest.connectedWallet?.toLowerCase() !== value.connectedWallet?.toLowerCase();
    latest = value; emit({ snapshot: value });
    if (changed && value.connectedWallet && value.chartUrl) window.location.assign(chartUrl(value.chartUrl));
  }
  async function connect() {
    if (!token || suspended || controller) return;
    const request = new AbortController(), currentGeneration = generation;
    controller = request;
    let reader = null, retry = true;
    try {
      const response = await fetch("/api/view/events", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ token }), signal: request.signal });
      if (!response.ok || !response.body) {
        if (response.status === 403) retry = false;
        throw new Error(response.status === 403 ? "This view link is unavailable." : "Connection updates unavailable.");
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!suspended && currentGeneration === generation) {
        const part = await reader.read();
        if (suspended || currentGeneration !== generation) break;
        if (part.done) throw new Error("Connection updates unavailable.");
        pending += decoder.decode(part.value, { stream: true });
        if (pending.length > 1024 * 1024) throw new Error("View update unavailable.");
        for (let boundary; (boundary = /\r?\n\r?\n/.exec(pending));) {
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          let event = "message";
          const data = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (event === "view" && data.length) accept(JSON.parse(data.join("\n")));
        }
      }
    } catch (error) {
      if (!suspended && currentGeneration === generation && !request.signal.aborted) emit({ error: error instanceof Error ? error.message : "Connection updates unavailable.", unauthorized: !retry });
    } finally {
      reader?.releaseLock();
      if (controller === request) controller = null;
      if (!suspended && currentGeneration === generation && retry) retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, 3000);
    }
  }
  window.rebalanceView = {
    token, fragment, chartUrl,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      if (latest) subscriber({ snapshot: latest });
      return () => subscribers.delete(subscriber);
    },
  };
  window.addEventListener("pagehide", () => {
    suspended = true; generation++;
    clearTimeout(retryTimer); retryTimer = null;
    controller?.abort(); controller = null;
  });
  window.addEventListener("pageshow", () => {
    if (suspended) {
      // Browser Back may restore a grid frozen before its last selection event.
      // Start that grid from today's selection without immediately leaving it.
      if (window.location.pathname === "/") latest = null;
      suspended = false; void connect();
    }
  });
  void connect();
})();
