// ============================================================
// Sniper — Four.meme Migration Listener (v3)
// ============================================================
// 已确认合约:
//   Four.meme Token Manager : 0x5c952063c7fc8610FFDB798152D69F0B9550762b
//   PancakeSwap Factory V2  : 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
//   PairCreated topic0      : 0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9
//
// 策略: 监听 PancakeSwap Factory PairCreated → 反查 tx.to
//       确认是 Four.meme Token Manager 发起的迁移交易
// ============================================================

const { ethers } = require("ethers");
const EventEmitter = require("events");
const { logger } = require("./logger");

const FOUR_MEME = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
const PANCAKE_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
];

class SniperBot extends EventEmitter {
  constructor(wssProvider, httpProvider, config) {
    super();
    this.wssProvider = wssProvider;
    this.httpProvider = httpProvider;
    this.config = config;

    this.processedTokens = new Set();
    this.processedTxs = new Set();
    this._reconnecting = false;
    this._reconnectAttempts = 0;
    this._heartbeat = null;
    this._bnbPrice = 600;
    this._bnbPriceTs = 0;
  }

  async start() {
    logger.info("══════════════════════════════════════════");
    logger.info("  Four.meme Migration Listener  (v3)");
    logger.info(`  Token Manager : ${FOUR_MEME}`);
    logger.info(`  Factory       : ${PANCAKE_FACTORY}`);
    logger.info("══════════════════════════════════════════");

    this._subscribe();
    this._startHeartbeat();
  }

  _subscribe() {
    const filter = { address: PANCAKE_FACTORY, topics: [PAIR_CREATED_TOPIC] };

    this.wssProvider.on(filter, async (log) => {
      try { await this._onPairCreated(log); }
      catch (e) { logger.error(`PairCreated handler: ${e.message}`); }
    });

    logger.info("  ✓ Subscribed to PairCreated logs");
  }

  async _onPairCreated(log) {
    const txHash = log.transactionHash;
    if (this.processedTxs.has(txHash)) return;
    this.processedTxs.add(txHash);
    this._trimSet(this.processedTxs, 5000);

    const token0 = ethers.getAddress("0x" + log.topics[1].slice(26));
    const token1 = ethers.getAddress("0x" + log.topics[2].slice(26));
    const [pairAddress] = ethers.AbiCoder.defaultAbiCoder()
      .decode(["address", "uint256"], log.data);

    const wl = WBNB.toLowerCase();
    let tokenAddr;
    if      (token0.toLowerCase() === wl) tokenAddr = token1;
    else if (token1.toLowerCase() === wl) tokenAddr = token0;
    else return;

    if (this.processedTokens.has(tokenAddr.toLowerCase())) return;

    if (!(await this._verifyFourMeme(txHash, tokenAddr))) return;

    this.processedTokens.add(tokenAddr.toLowerCase());

    logger.info("════════════════════════════════════════");
    logger.info(`  FOUR.MEME MIGRATION!`);
    logger.info(`  Token : ${tokenAddr}`);
    logger.info(`  Pair  : ${pairAddress}`);
    logger.info(`  Tx    : ${txHash}`);
    logger.info("════════════════════════════════════════");

    await this._processToken(tokenAddr, pairAddress);
  }

  async _verifyFourMeme(txHash, tokenAddr) {
    try {
      const tx = await this.httpProvider.getTransaction(txHash);
      if (tx?.to?.toLowerCase() === FOUR_MEME.toLowerCase()) return true;

      const receipt = await this.httpProvider.getTransactionReceipt(txHash);
      if (receipt) {
        for (const l of receipt.logs) {
          if (l.address.toLowerCase() === FOUR_MEME.toLowerCase()) return true;
        }
      }

      const tok = new ethers.Contract(tokenAddr, ERC20_ABI, this.httpProvider);
      const bal = await tok.balanceOf(FOUR_MEME).catch(() => 0n);
      if (bal > 0n) return true;
    } catch (e) {
      logger.warn(`  verify error: ${e.message}`);
    }
    return false;
  }

  async _processToken(tokenAddr, pairAddress) {
    const t0 = Date.now();
    try {
      const tok = new ethers.Contract(tokenAddr, ERC20_ABI, this.httpProvider);

      const [symbol, , totalSupply, decimals] = await Promise.all([
        tok.symbol().catch(() => "???"),
        tok.name().catch(() => ""),
        tok.totalSupply().catch(() => 0n),
        tok.decimals().catch(() => 18),
      ]);

      // 取 holders + LP/FDV (holders 仅用于展示，不做过滤)
      const [holders, { lp, fdv }] = await Promise.all([
        this._getHolders(tokenAddr),
        this._calcLpFdv(tokenAddr, pairAddress, totalSupply, decimals),
      ]);

      logger.info(`  ${symbol} | holders=${holders} LP=$${lp} FDV=$${fdv} (${Date.now() - t0}ms)`);
      this.emit("migration", tokenAddr, symbol, lp, fdv, holders);
    } catch (e) {
      logger.error(`processToken ${tokenAddr}: ${e.message}`);
    }
  }

  async _getHolders(addr) {
    try {
      const r = await fetch(
        `https://public-api.birdeye.so/defi/token_overview?address=${addr}`,
        { headers: { "X-API-KEY": process.env.BIRDEYE_API_KEY, "x-chain": "bsc" },
          signal: AbortSignal.timeout(3000) }
      );
      const d = await r.json();
      if (d.success && d.data?.holder) return d.data.holder;
    } catch (_) {}

    try {
      const key = process.env.BSCSCAN_API_KEY || "YourApiKeyToken";
      const r = await fetch(
        `https://api.bscscan.com/api?module=token&action=tokeninfo&contractaddress=${addr}&apikey=${key}`,
        { signal: AbortSignal.timeout(3000) }
      );
      const d = await r.json();
      if (d.status === "1" && d.result?.[0]?.holdersCount)
        return parseInt(d.result[0].holdersCount);
    } catch (_) {}

    return 0;
  }

  async _calcLpFdv(tokenAddr, pairAddr, totalSupply, decimals) {
    if (pairAddr) {
      try {
        const pair = new ethers.Contract(pairAddr, PAIR_ABI, this.httpProvider);
        const [reserves, t0Addr] = await Promise.all([
          pair.getReserves(), pair.token0(),
        ]);
        const isT0 = t0Addr.toLowerCase() === tokenAddr.toLowerCase();
        const tokRes = isT0 ? reserves[0] : reserves[1];
        const bnbRes = isT0 ? reserves[1] : reserves[0];

        const bnbP = await this._getBnbPrice();
        const bnbFloat = parseFloat(ethers.formatEther(bnbRes));
        const lp = Math.floor(bnbFloat * bnbP * 2);
        const tokFloat = parseFloat(ethers.formatUnits(tokRes, decimals));
        const price = tokFloat > 0 ? (bnbFloat * bnbP) / tokFloat : 0;
        const fdv = Math.floor(price * parseFloat(ethers.formatUnits(totalSupply, decimals)));
        return { lp, fdv };
      } catch (e) { logger.warn(`  on-chain LP calc: ${e.message}`); }
    }

    try {
      const r = await fetch(
        `https://public-api.birdeye.so/defi/token_overview?address=${tokenAddr}`,
        { headers: { "X-API-KEY": process.env.BIRDEYE_API_KEY, "x-chain": "bsc" },
          signal: AbortSignal.timeout(3000) }
      );
      const d = await r.json();
      return { lp: Math.floor(d.data?.liquidity || 0), fdv: Math.floor(d.data?.fdv || 0) };
    } catch (_) {}
    return { lp: 0, fdv: 0 };
  }

  async _getBnbPrice() {
    if (Date.now() - this._bnbPriceTs < 30000) return this._bnbPrice;
    try {
      const r = await fetch(
        `https://public-api.birdeye.so/defi/price?address=${WBNB}`,
        { headers: { "X-API-KEY": process.env.BIRDEYE_API_KEY, "x-chain": "bsc" },
          signal: AbortSignal.timeout(2000) }
      );
      const d = await r.json();
      this._bnbPrice = d.data?.value || 600;
      this._bnbPriceTs = Date.now();
    } catch (_) {}
    return this._bnbPrice;
  }

  _startHeartbeat() {
    this._heartbeat = setInterval(async () => {
      try {
        await this.wssProvider.getBlockNumber();
        this._reconnectAttempts = 0;
      } catch (_) {
        logger.warn("WSS heartbeat failed");
        this._reconnect();
      }
    }, 30000);

    this.wssProvider.on("error", () => this._reconnect());
  }

  async _reconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;

    if (this._reconnectAttempts >= 10) {
      logger.error("Max reconnects reached — exiting");
      process.exit(1);
    }

    this._reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this._reconnectAttempts, 30000);
    logger.info(`Reconnecting in ${delay / 1000}s (#${this._reconnectAttempts})`);

    await new Promise(r => setTimeout(r, delay));

    try {
      if (this._heartbeat) clearInterval(this._heartbeat);
      this.wssProvider.removeAllListeners();
      this.wssProvider = new ethers.WebSocketProvider(this.config.ALCHEMY_WSS);
      await this.wssProvider.ready;
      this._subscribe();
      this._startHeartbeat();
      this._reconnectAttempts = 0;
      logger.info("Reconnected ✓");
    } catch (e) {
      logger.error(`Reconnect failed: ${e.message}`);
      this._reconnecting = false;
      this._reconnect();
      return;
    }
    this._reconnecting = false;
  }

  _trimSet(s, keep) { if (s.size > keep * 2) { const a = [...s]; s.clear(); a.slice(-keep).forEach(v => s.add(v)); } }

  stop() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this.wssProvider.removeAllListeners();
    logger.info("Sniper stopped");
  }
}

module.exports = { SniperBot };
