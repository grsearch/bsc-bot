// ============================================================
// Price Monitor — Birdeye API (v3)
// 变更: cacheTTL 改为 4000ms 配合 5 秒轮询间隔
// ============================================================

const { logger } = require("./logger");

class PriceMonitor {
  constructor(config) {
    this.apiKey = config.BIRDEYE_API_KEY;
    this.base = "https://public-api.birdeye.so";
    this.cache = new Map();
    this.cacheTTL = 4000; // 4 秒缓存 (配合 5 秒轮询)
  }

  async getPrice(tokenAddress) {
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.ts < this.cacheTTL) return cached.data;

    try {
      const r = await fetch(`${this.base}/defi/token_overview?address=${tokenAddress}`, {
        headers: { "X-API-KEY": this.apiKey, "x-chain": "bsc" },
        signal: AbortSignal.timeout(5000),
      });

      if (r.status === 429) {
        logger.warn("Birdeye 429, backing off");
        await this._sleep(2000);
        return null;
      }
      if (!r.ok) return null;

      const d = await r.json();
      if (!d.success || !d.data) return null;

      const result = {
        price: d.data.price || 0,
        fdv: d.data.fdv || 0,
        liquidity: d.data.liquidity || 0,
        holders: d.data.holder || 0,
      };

      this.cache.set(tokenAddress, { data: result, ts: Date.now() });
      return result;
    } catch (e) {
      logger.error(`Birdeye price ${tokenAddress.slice(0, 10)}: ${e.message}`);
      return null;
    }
  }

  async getBatchPrices(addresses) {
    if (!addresses.length) return new Map();
    try {
      const list = addresses.slice(0, 100).join(",");
      const r = await fetch(`${this.base}/defi/multi_price?list_address=${list}`, {
        headers: { "X-API-KEY": this.apiKey, "x-chain": "bsc" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return new Map();
      const d = await r.json();
      const out = new Map();
      if (d.success && d.data) {
        for (const [addr, info] of Object.entries(d.data)) {
          out.set(addr.toLowerCase(), info.value || 0);
        }
      }
      return out;
    } catch (e) {
      logger.error(`Birdeye batch: ${e.message}`);
      return new Map();
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { PriceMonitor };
