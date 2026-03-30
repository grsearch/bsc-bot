// ============================================================
// Security Checker — GoPlus + Honeypot.is
// ============================================================

const { logger } = require("./logger");

class SecurityChecker {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000;
  }

  async check(tokenAddress) {
    const key = tokenAddress.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < this.cacheTTL) return cached.result;

    const [gp, hp] = await Promise.allSettled([
      this._goplus(tokenAddress),
      this._honeypot(tokenAddress),
    ]);

    const goplus = gp.status === "fulfilled" ? gp.value : null;
    const honeypot = hp.status === "fulfilled" ? hp.value : null;
    const issues = [];

    if (goplus) {
      if (goplus.is_honeypot === "1")            issues.push("honeypot");
      if (goplus.is_mintable === "1")             issues.push("mintable");
      if (goplus.can_take_back_ownership === "1") issues.push("ownership reclaimable");
      if (goplus.is_blacklisted === "1")          issues.push("blacklist");
      if (goplus.is_proxy === "1")                issues.push("proxy/upgradable");
      if (goplus.cannot_sell_all === "1")          issues.push("cannot sell all");
      if (goplus.transfer_pausable === "1")       issues.push("pausable");
      if (goplus.slippage_modifiable === "1")     issues.push("slippage modifiable");

      const bt = parseFloat(goplus.buy_tax || "0");
      const st = parseFloat(goplus.sell_tax || "0");
      if (bt > 0.10) issues.push(`buy tax ${(bt * 100).toFixed(0)}%`);
      if (st > 0.10) issues.push(`sell tax ${(st * 100).toFixed(0)}%`);
    }

    if (honeypot) {
      if (honeypot.honeypotResult?.isHoneypot)  issues.push("honeypot.is confirmed");
      if (honeypot.simulationSuccess === false)  issues.push("simulation failed");
      if ((honeypot.simulationResult?.buyTax || 0) > 10) issues.push("hp buy tax high");
      if ((honeypot.simulationResult?.sellTax || 0) > 10) issues.push("hp sell tax high");
    }

    const result = {
      safe: issues.length === 0,
      reason: issues.length ? issues.join("; ") : "OK",
      buyTax: goplus ? parseFloat(goplus.buy_tax || "0") * 100 : null,
      sellTax: goplus ? parseFloat(goplus.sell_tax || "0") * 100 : null,
    };

    this.cache.set(key, { result, ts: Date.now() });
    return result;
  }

  async _goplus(addr) {
    try {
      const r = await fetch(
        `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${addr}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return null;
      const d = await r.json();
      if (d.code !== 1) return null;
      return d.result?.[addr.toLowerCase()] || null;
    } catch (_) { return null; }
  }

  async _honeypot(addr) {
    try {
      const r = await fetch(
        `https://api.honeypot.is/v2/IsHoneypot?address=${addr}&chainID=56`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }
}

module.exports = { SecurityChecker };
