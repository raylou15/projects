export const PROTOCOL_VERSION = 1;

export const CLIENT_TYPES = new Set(["join", "guess", "stats", "hint_request"]);

export function validateMessage(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Message must be an object." };
  }

  if ((raw.v ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol version: ${raw.v}` };
  }

  if (!CLIENT_TYPES.has(raw.t)) {
    return { ok: false, error: `Unknown message type: ${raw.t}` };
  }

  return { ok: true };
}

export function cleanText(input, max = 180) {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}
