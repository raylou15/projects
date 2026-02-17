#!/usr/bin/env node
import { WebSocket } from "../apps/rays-games/node_modules/ws/wrapper.mjs";

const base = (process.argv[2] || "https://rays-games.loseyourip.com").replace(/\/$/, "");
const wsBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const targets = [
  `${wsBase}/ws`,
  `${wsBase}/context-clues/ws`,
  `${wsBase}/ws?instance_id=diag-instance`,
];

function probe(url) {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      resolve(result);
    };

    ws.on("upgrade", (res) => {
      done({ ok: true, status: res.statusCode || 101 });
    });
    ws.on("open", () => {
      done({ ok: true, status: 101 });
    });
    ws.on("unexpected-response", (_req, res) => {
      done({ ok: false, status: res.statusCode || 0, reason: `unexpected-response` });
    });
    ws.on("error", (err) => {
      done({ ok: false, status: 0, reason: err.message });
    });
    setTimeout(() => done({ ok: false, status: 0, reason: "timeout" }), 5500);
  });
}

for (const url of targets) {
  const r = await probe(url);
  if (r.ok) console.log(`PASS ${url} -> ${r.status}`);
  else console.log(`FAIL ${url} -> ${r.status} (${r.reason})`);
}
