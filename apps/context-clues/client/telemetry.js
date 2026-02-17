const ENDPOINT = "/api/client-log";

function post(payload) {
  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(ENDPOINT, blob);
      return;
    }
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export function logClientEvent(game, level, message, meta = {}) {
  post({ game, level, message, meta });
}

export function initTelemetry(game) {
  logClientEvent(game, "info", "boot: telemetry online", { path: location.pathname, qs: location.search });

  window.addEventListener("error", (e) => {
    logClientEvent(game, "error", `window.error: ${e.message || "unknown"}`, {
      file: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error?.stack || null,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason?.stack || e.reason?.message || String(e.reason);
    logClientEvent(game, "error", "unhandledrejection", { reason });
  });
}

export function showBootError(game, err) {
  const msg = err?.message || String(err);
  logClientEvent(game, "error", "boot failed", { msg, stack: err?.stack || null });

  document.body.innerHTML = `
  <pre style="padding:12px;white-space:pre-wrap;color:#b00020;font:14px/1.4 system-ui,sans-serif">
Boot failed: ${escapeHtml(msg)}
  </pre>`;
}

function escapeHtml(s = "") {
  return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
