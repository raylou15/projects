function resolveWsUrl() {
  if (import.meta.env.DEV) {
    const devOverride = (import.meta.env.VITE_WS_URL || "").trim();
    if (devOverride) return devOverride;
  }

  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createWsClient({ onMessage, onStatus, getJoinPayload, onTelemetry }) {
  let ws = null;
  let reconnectTimer = null;
  let reconnectMs = 1000;
  let manuallyClosed = false;

  function connect() {
    manuallyClosed = false;
    onStatus("connecting");
    const wsUrl = resolveWsUrl();
    onTelemetry?.("info", "ws.connect_attempt", { wsUrl });
    ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      onTelemetry?.("info", "ws.open", { wsUrl });
      onStatus("connected");
      reconnectMs = 1000;
      const joinPayload = getJoinPayload();
      if (joinPayload) send(joinPayload);
    });

    ws.addEventListener("message", (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        onMessage({ t: "error", message: "Bad message from server." });
      }
    });

    ws.addEventListener("close", (event) => {
      onTelemetry?.("warn", "ws.close", { wsUrl, code: event.code, reason: event.reason || "", wasClean: event.wasClean });
      onStatus("disconnected");
      if (!manuallyClosed) {
        reconnectTimer = setTimeout(connect, reconnectMs);
        reconnectMs = Math.min(10_000, reconnectMs * 1.5);
      }
    });

    ws.addEventListener("error", (event) => {
      const err = event?.error;
      onTelemetry?.("error", "ws.error", { wsUrl, message: err?.message || "socket error" });
      onStatus("error");
    });
  }

  function send(payload) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ v: 1, ...payload }));
    return true;
  }

  function close() {
    manuallyClosed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws && ws.readyState <= 1) ws.close();
  }

  return { connect, send, close };
}
