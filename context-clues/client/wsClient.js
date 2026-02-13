export function createWsClient({ onMessage, onStatus, getJoinPayload }) {
  let ws = null;
  let reconnectTimer = null;
  let reconnectMs = 1000;
  let manuallyClosed = false;

  const wsUrl = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  };

  function connect() {
    manuallyClosed = false;
    onStatus("connecting");
    ws = new WebSocket(wsUrl());

    ws.addEventListener("open", () => {
      onStatus("connected");
      reconnectMs = 1000;
      const joinPayload = getJoinPayload();
      if (joinPayload) {
        send(joinPayload);
      }
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        onMessage(msg);
      } catch {
        onMessage({ t: "error", error: "Bad message from server." });
      }
    });

    ws.addEventListener("close", () => {
      onStatus("disconnected");
      if (!manuallyClosed) {
        reconnectTimer = setTimeout(connect, reconnectMs);
        reconnectMs = Math.min(10_000, reconnectMs * 1.5);
      }
    });

    ws.addEventListener("error", () => {
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
    reconnectTimer = null;
    if (ws && ws.readyState <= 1) {
      ws.close();
    }
  }

  return { connect, send, close };
}
