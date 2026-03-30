// ============================================================
// Price Monitor — Birdeye API (v2)
// B-05: 100 rps, 50M CUs/month
// FIX: getPrice 现在返回 { price, fdv } (使用 token_overview)
//      多持仓时使用 batch 端点减少请求数
// ============================================================

const { logger } = require("./logger");

class PriceMonitor {
  constructor(config) {
    this.apiKey = config.BIRDEYE_API_KEY;
    this.base = "https://public-api.birdeye.so";
    this.cache = new Map();
    this.cacheTTL = 800; // ms
  }

  /**
   * 获取单个代币的 price + fdv
   * 使用 token_overview 端点（一次请求拿到 price + fdv + liquidity）
   */
  async getPrice(tokenAddress) {
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.ts < this.cacheTTL) return cached.data;

    try {
      const r = await fetch(`${this.base}/defi/token_overview?address=${tokenAddress}`, {
        headers: { "X-API-KEY": this.apiKey, "x-chain": "bsc" },
        signal: AbortSignal.timeout(3000),
      });

      if (r.status === 429) {
        logger.warn("Birdeye 429, backing off");
        await this._sleep(1000);
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

  /**
   * 批量获取价格 (≤100 地址)
   * 适用于多持仓场景，一次请求拿所有价格
   */
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
