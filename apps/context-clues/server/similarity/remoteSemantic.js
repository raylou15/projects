import fetch from "node-fetch";

class LruCache {
  constructor(limit = 300) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

export class RemoteSemanticHelper {
  constructor({ enabled = false, rateLimitPerMinute = 20, cacheSize = 300 } = {}) {
    this.enabled = enabled;
    this.calls = [];
    this.cache = new LruCache(cacheSize);
    this.rateLimitPerMinute = rateLimitPerMinute;
  }

  canCall() {
    const cutoff = Date.now() - 60_000;
    this.calls = this.calls.filter((ts) => ts > cutoff);
    return this.calls.length < this.rateLimitPerMinute;
  }

  async relatedness(targetWord, guessWord) {
    if (!this.enabled) return null;
    const key = `${targetWord}::${guessWord}`;
    const cached = this.cache.get(key);
    if (cached !== null) return cached;

    if (!this.canCall()) return null;

    const url = `https://api.conceptnet.io/relatedness?node1=/c/en/${encodeURIComponent(
      targetWord,
    )}&node2=/c/en/${encodeURIComponent(guessWord)}`;

    try {
      this.calls.push(Date.now());
      const resp = await fetch(url, { timeout: 2500 });
      if (!resp.ok) return null;
      const payload = await resp.json();
      const score = Number(payload?.value);
      if (!Number.isFinite(score)) return null;
      this.cache.set(key, score);
      return score;
    } catch {
      return null;
    }
  }
}
