const WS_URL_OVERRIDE = import.meta.env.DEV ? (import.meta.env.VITE_WS_URL || "").trim() : "";

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function postClientLog(game, level, message, meta) {
  try {
    fetch("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ game, level, message, meta }),
      // keepalive helps logs survive unloads in iframe contexts
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

function resolveWsUrl() {
  if (WS_URL_OVERRIDE) return WS_URL_OVERRIDE;

  // Always same-origin in production (Discord proxy expects this).
  // Also forward the Activity querystring (instance_id, discord_proxy_ticket, etc).
  const url = new URL("/ws", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.search = window.location.search;
  return url.toString();
}

export function createWsClient({ game = "unknown", onMessage = () => {}, onStatus = () => {} } = {}) {
  let ws = null;
  let pingTimer = null;
  let lastOpenAt = 0;

  function setStatus(s, meta) {
    onStatus(s);
    if (meta) postClientLog(game, "info", `ws.status:${s}`, meta);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const wsUrl = resolveWsUrl();
    setStatus("connecting", { wsUrl });

    postClientLog(game, "info", "ws.connect", { wsUrl });

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      lastOpenAt = Date.now();
      setStatus("connected", { wsUrl });
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        try {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping", ts: Date.now() }));
        } catch {}
      }, 15000);
    };

    ws.onmessage = (evt) => {
      const payload = typeof evt.data === "string" ? safeJsonParse(evt.data) : null;
      if (payload) onMessage(payload);
    };

    ws.onerror = (evt) => {
      // Browser doesn't give much detail; still log that it happened.
      postClientLog(game, "error", "ws.error", {
        wsUrl,
        readyState: ws ? ws.readyState : null,
        openedMsAgo: lastOpenAt ? Date.now() - lastOpenAt : null,
      });
      setStatus("error");
    };

    ws.onclose = (evt) => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;

      postClientLog(game, "warn", "ws.close", {
        wsUrl,
        code: evt.code,
        reason: evt.reason,
        wasClean: evt.wasClean,
        openedMsAgo: lastOpenAt ? Date.now() - lastOpenAt : null,
      });

      setStatus("closed");

      // small backoff retry
      setTimeout(() => {
        // only retry if we didn't immediately reconnect elsewhere
        if (!ws || ws.readyState === WebSocket.CLOSED) connect();
      }, 750);
    };
  }

  function send(obj) {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    } catch {}
  }

  return { connect, send };
}
