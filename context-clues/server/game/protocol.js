export const PROTOCOL_VERSION = 1;

export const CLIENT_TYPES = new Set([
  "join",
  "leave",
  "ready",
  "start_game",
  "submit_clue",
  "submit_guess",
  "next_phase",
  "chat",
]);

export function validateMessage(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Message must be an object." };
  }

  const v = raw.v ?? PROTOCOL_VERSION;
  if (v !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol version: ${v}` };
  }

  if (!CLIENT_TYPES.has(raw.t)) {
    return { ok: false, error: `Unknown message type: ${raw.t}` };
  }

  return { ok: true, v, type: raw.t };
}

export function cleanText(input, max = 120) {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}
