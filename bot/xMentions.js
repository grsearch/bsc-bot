// ============================================================
// X Mentions Checker — Twitter API v2 (v2)
// FIX: counts 端点 403 时自动 fallback 到 search/recent
// ============================================================

const { logger } = require("./logger");

class XMentionsChecker {
  constructor(bearerToken, proxyUrl = null) {
    this.bearer = bearerToken;
    this.proxyUrl = proxyUrl;
    this.base = "https://api.twitter.com/2";
    this.cache = new Map();
    this.cacheTTL = 3 * 60 * 1000;
    this.useProxy = false;
    this.countsAvailable = true;  // 首次假设可用，403 后切 false
  }

  async getCount(contractAddress) {
    if (!this.bearer) return 0;

    const key = contractAddress.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < this.cacheTTL) return cached.count;

    try {
      const count = this.countsAvailable
        ? await this._counts(contractAddress)
        : await this._search(contractAddress);

      this.cache.set(key, { count, ts: Date.now() });
      return count;
    } catch (e) {
      // 直连失败 → 切代理重试
      if (!this.useProxy && this.proxyUrl) {
        logger.warn(`X direct failed: ${e.message}, switching to proxy`);
        this.useProxy = true;
        return this.getCount(contractAddress);
      }
      logger.error(`X mentions failed: ${e.message}`);
      return 0;
    }
  }

  // ── /2/tweets/counts/recent（最省配额） ──
  async _counts(contractAddress) {
    const q = encodeURIComponent(contractAddress);
    const since = new Date(Date.now() - 86400000).toISOString();
    const url = `${this.base}/tweets/counts/recent?query=${q}&start_time=${since}&granularity=day`;

    const resp = await this._fetch(url);

    if (resp.status === 403) {
      logger.warn("X counts endpoint 403 — falling back to search");
      this.countsAvailable = false;
      return this._search(contractAddress);
    }
    if (resp.status === 429) throw new Error("rate limited");
    if (!resp.ok) throw new Error(`counts ${resp.status}`);

    const d = await resp.json();
    return d.meta?.total_tweet_count || 0;
  }

  // ── /2/tweets/search/recent（fallback） ──
  async _search(contractAddress) {
    const q = encodeURIComponent(contractAddress);
    const url = `${this.base}/tweets/search/recent?query=${q}&max_results=100`;

    const resp = await this._fetch(url);
    if (resp.status === 429) throw new Error("rate limited");
    if (!resp.ok) throw new Error(`search ${resp.status}`);

    const d = await resp.json();
    return d.meta?.result_count || 0;
  }

  async _fetch(url) {
    const headers = { Authorization: `Bearer ${this.bearer}` };

    if (this.useProxy && this.proxyUrl) {
      try {
        const { ProxyAgent } = require("undici");
        return await fetch(url, { headers, dispatcher: new ProxyAgent(this.proxyUrl) });
      } catch (_) {
        try {
          const { HttpsProxyAgent } = require("https-proxy-agent");
          const nf = require("node-fetch");
          return await nf(url, { headers, agent: new HttpsProxyAgent(this.proxyUrl) });
        } catch (e2) { throw new Error(`proxy failed: ${e2.message}`); }
      }
    }

    return fetch(url, { headers });
  }
}

module.exports = { XMentionsChecker };
