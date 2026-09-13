(() => {
  "use strict";
  const token = /^#view=([a-f0-9]{64})$/i.exec(window.location.hash)?.[1] || null;
  const fragment = token ? `#view=${token}` : "";
  const subscribers = new Set(), controlHolds = new Set();
  let latest = null, controller = null, retryTimer = null, suspended = document.visibilityState === "hidden", generation = 0;
  let pageHidden = false, returningToSelector = false, navigating = false;
  let navigationReleases = [], navigationTimer = null, failedNavigation = null;
  function releaseNavigation() {
    clearTimeout(navigationTimer); navigationTimer = null;
    const releases = navigationReleases; navigationReleases = [];
    for (const release of releases.reverse()) release();
    navigating = false;
  }
  function navigate(url, onFailure, explicit = false) {
    if (navigating || pageHidden || !explicit && url === failedNavigation) return;
    failedNavigation = null;
    navigating = true;
    try {
      navigationReleases.push(suspendForControl());
      const releaseStatus = window.rebalanceStatus?.suspendForControl?.();
      if (typeof releaseStatus === "function") navigationReleases.push(releaseStatus);
      window.location.assign(url);
      // assign() only starts a document request. A saturated destination origin
      // can leave this page alive indefinitely without an exception or pagehide.
      navigationTimer = setTimeout(() => {
        navigationTimer = null;
        if (!navigating || pageHidden) return;
        try { window.stop?.(); } catch { /* A failed load is still reported. */ }
        // The resumed stream establishes a baseline; it must not retry this
        // same failed navigation automatically from its first snapshot.
        failedNavigation = url; latest = null; returningToSelector = false;
        releaseNavigation();
        const message = "The page did not open. Try opening the portfolio or selector again; your saved connection is unchanged.";
        emit({ error: message, navigation: true });
        if (typeof onFailure === "function") onFailure(message);
      }, 15000);
    } catch (error) {
      releaseNavigation(); throw error;
    }
  }
  function openSelector(onFailure, explicit = true) {
    if (returningToSelector || pageHidden || !explicit && failedNavigation === `/${fragment}`) return;
    returningToSelector = true;
    try { navigate(`/${fragment}`, onFailure, explicit); }
    catch (error) { returningToSelector = false; throw error; }
  }
  function chartUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      if (!["http:", "https:"].includes(url.protocol) || url.protocol !== window.location.protocol ||
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password ||
          url.pathname !== "/chart" || url.search || url.hash) return null;
      // Keep the browser on its current loopback host instead of crossing
      // into a different connection pool when the registry uses 127.0.0.1.
      if (!["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)) return null;
      url.hostname = window.location.hostname;
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
    if (value.connectedWallet === null && window.location.pathname === "/chart") openSelector(undefined, false);
    else if (changed && value.connectedWallet && value.chartUrl) navigate(chartUrl(value.chartUrl));
  }
  async function connect() {
    if (!token || suspended || controlHolds.size || controller) return;
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
          if (suspended || currentGeneration !== generation) break;
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
      void reader?.cancel().catch(() => {}); reader?.releaseLock(); request.abort();
      if (controller === request) controller = null;
      if (!suspended && !controlHolds.size && currentGeneration === generation && retry) retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, 3000);
    }
  }
  window.rebalanceView = {
    token, fragment, chartUrl, openSelector, suspendForControl,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      if (latest) subscriber({ snapshot: latest });
      return () => subscribers.delete(subscriber);
    },
  };
  function stopTransport() {
    generation++;
    clearTimeout(retryTimer); retryTimer = null;
    controller?.abort(); controller = null;
  }
  function suspendForControl() {
    const hold = {};
    controlHolds.add(hold);
    if (controlHolds.size === 1) stopTransport();
    return (options) => {
      if (!controlHolds.delete(hold)) return;
      if (options?.resetSelectionBaseline) latest = null;
      if (controlHolds.size || suspended || pageHidden || document.visibilityState === "hidden") return;
      void connect();
    };
  }
  function suspend() {
    if (suspended) return;
    suspended = true; stopTransport();
  }
  function resume() {
    if (!suspended || pageHidden || document.visibilityState === "hidden") return;
    // Back and a restored background grid accept the current selection as a
    // baseline; a later agent selection can still open its portfolio.
    if (window.location.pathname === "/") latest = null;
    suspended = false; void connect();
  }
  window.addEventListener("pagehide", () => { pageHidden = true; clearTimeout(navigationTimer); navigationTimer = null; suspend(); });
  window.addEventListener("pageshow", () => {
    const restored = pageHidden;
    pageHidden = false;
    // Release while both modules are still lifecycle-suspended; the status
    // module's later pageshow handler will resume its own connection once.
    if (restored) { returningToSelector = false; releaseNavigation(); }
    resume();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") suspend(); else resume();
  });
  void connect();
})();
