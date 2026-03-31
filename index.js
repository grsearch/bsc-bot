// ============================================================
// Four.meme BSC Migration Sniper Bot (v3)
// ============================================================
// 变更:
//   1. 去掉 holders 限制、X 提及量过滤、代理
//   2. 新增 X Monitor: 每分钟拉取 @cz_binance @heyibinance 推文，缓存 30 分钟
//   3. 迁移事件发生时，用 DeepSeek API 评估代币与推文关联性
//   4. 去掉 30 分钟监控期 (不自动到期清仓)
//   5. 去掉 FDV 过低退出
//   6. Birdeye 价格轮询改为 5 秒
// ============================================================

require("dotenv").config();
const { ethers } = require("ethers");
const { SniperBot } = require("./bot/sniper");
const { PriceMonitor } = require("./bot/priceMonitor");
const { SecurityChecker } = require("./bot/security");
const { XMonitor } = require("./bot/xMentions");
const { DeepSeekEvaluator } = require("./bot/deepseekEval");
const { TradeExecutor } = require("./bot/tradeExecutor");
const { Dashboard } = require("./bot/dashboard");
const { logger } = require("./bot/logger");

// ── Config ──
const C = {
  ALCHEMY_WSS:   process.env.ALCHEMY_WSS  || "wss://bsc-mainnet.g.alchemy.com/v2/YOUR_KEY",
  ALCHEMY_HTTP:  process.env.ALCHEMY_HTTP  || "https://bsc-mainnet.g.alchemy.com/v2/YOUR_KEY",
  MEV_GUARD_RPC: process.env.MEV_GUARD_RPC || "https://bscrpc.pancakeswap.finance",
  PRIVATE_KEY:   process.env.PRIVATE_KEY,
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY,
  X_BEARER_TOKEN:  process.env.X_BEARER_TOKEN,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,

  PANCAKE_ROUTER_V2: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",

  BUY_AMOUNT_BNB:    parseFloat(process.env.BUY_AMOUNT_BNB || "0.2"),
  SLIPPAGE_PERCENT:  parseInt(process.env.SLIPPAGE_PERCENT  || "30"),
  GAS_PRICE_GWEI:    parseInt(process.env.GAS_PRICE_GWEI    || "5"),
  GAS_LIMIT:         parseInt(process.env.GAS_LIMIT          || "500000"),

  TRAILING_ACTIVATE: 50,   // +50% 激活移动止损
  TRAILING_STOP:     30,   // 从最高点回撤 30% 卖出
  HARD_STOP:         30,   // 直接跌 30% 止损

  POLL_INTERVAL:  5000,    // 价格轮询间隔 5 秒 (原 1 秒)
  DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT || "3000"),
};

async function main() {
  logger.info("══════════════════════════════════════════");
  logger.info("  Four.meme BSC Migration Sniper Bot v3");
  logger.info("  策略: CZ/何一推文关联 + DeepSeek 评估");
  logger.info("══════════════════════════════════════════");

  // 校验必填配置
  if (!C.PRIVATE_KEY)      { logger.error("PRIVATE_KEY missing in .env"); process.exit(1); }
  if (!C.BIRDEYE_API_KEY)  { logger.error("BIRDEYE_API_KEY missing in .env"); process.exit(1); }
  if (!C.X_BEARER_TOKEN)     logger.warn("X_BEARER_TOKEN missing — X monitor disabled");
  if (!C.DEEPSEEK_API_KEY)   logger.warn("DEEPSEEK_API_KEY missing — AI evaluation disabled");

  // ── Providers ──
  const wssProvider  = new ethers.WebSocketProvider(C.ALCHEMY_WSS);
  const httpProvider = new ethers.JsonRpcProvider(C.ALCHEMY_HTTP);
  const mevProvider  = new ethers.JsonRpcProvider(C.MEV_GUARD_RPC);

  const wallet = new ethers.Wallet(C.PRIVATE_KEY, mevProvider);
  const balance = await mevProvider.getBalance(wallet.address);
  logger.info(`Wallet:  ${wallet.address}`);
  logger.info(`Balance: ${ethers.formatEther(balance)} BNB`);
  if (balance < ethers.parseEther("0.3")) logger.warn("Balance low — recommend ≥ 0.3 BNB");

  // ── Modules ──
  const security   = new SecurityChecker();
  const xMonitor   = new XMonitor(C.X_BEARER_TOKEN);
  const deepseek   = new DeepSeekEvaluator(C.DEEPSEEK_API_KEY);
  const executor   = new TradeExecutor(wallet, C);
  const priceWatch = new PriceMonitor(C);
  const dashboard  = new Dashboard(C.DASHBOARD_PORT);

  dashboard.start();
  await xMonitor.start();

  // ── State ──
  const positions   = new Map();
  const soldTokens  = new Set();
  let   monitorBusy = false;

  // ════════════════════════════════════════
  // 迁移检测回调
  // ════════════════════════════════════════
  async function onMigration(tokenAddr, symbol, lp, fdv, holders) {
    logger.info(`🔍 Migration: ${symbol} (${tokenAddr.slice(0, 10)}...)`);

    if (soldTokens.has(tokenAddr) || positions.has(tokenAddr)) {
      logger.info(`  skip — already traded/monitoring`);
      return;
    }

    // Step 1: 安全检查 (GoPlus + Honeypot.is)
    const sec = await security.check(tokenAddr);
    if (!sec.safe) {
      logger.warn(`  ✗ Security FAIL: ${sec.reason}`);
      dashboard.addDetectedToken({
        tokenAddress: tokenAddr, symbol, lp, fdv, holders,
        safe: false, qualified: false, aiEval: null,
      });
      return;
    }

    // Step 2: 立即拉取最新推文 + DeepSeek 关联性评估
    const recentTweets = await xMonitor.fetchLatest();
    logger.info(`  Recent tweets (fresh pull): ${recentTweets.length}`);

    let aiResult = { relevant: false, reason: "no tweets", confidence: 0 };
    if (recentTweets.length > 0) {
      aiResult = await deepseek.evaluate(tokenAddr, symbol, recentTweets);
    }

    const qualified = aiResult.relevant && aiResult.confidence >= 60;

    dashboard.addDetectedToken({
      tokenAddress: tokenAddr, symbol, lp, fdv, holders,
      safe: true, qualified,
      aiEval: { relevant: aiResult.relevant, confidence: aiResult.confidence, reason: aiResult.reason },
    });

    if (!qualified) {
      logger.warn(`  ✗ AI eval: relevant=${aiResult.relevant} confidence=${aiResult.confidence} — ${aiResult.reason}`);
      return;
    }

    // Step 3: 买入
    logger.info(`  ✓ AI PASS (confidence=${aiResult.confidence}) — Buying ${C.BUY_AMOUNT_BNB} BNB`);
    logger.info(`  Reason: ${aiResult.reason}`);
    const buyResult = await executor.buy(tokenAddr, C.BUY_AMOUNT_BNB);
    if (!buyResult.success) {
      logger.error(`  ✗ Buy failed: ${buyResult.error}`);
      return;
    }

    const pos = {
      tokenAddress: tokenAddr,
      symbol,
      entryPrice:   buyResult.price,
      currentPrice: buyResult.price,
      highestPrice: buyResult.price,
      tokenAmount:  buyResult.tokenAmount,
      decimals:     buyResult.decimals,
      bnbAmount:    C.BUY_AMOUNT_BNB,
      buyTxHash:    buyResult.txHash,
      buyTime:      Date.now(),
      trailingActive: false,
      pnl: 0,
      fdv: fdv,
      aiReason:     aiResult.reason,
    };

    positions.set(tokenAddr, pos);
    dashboard.addActivePosition(pos);
    dashboard.addTrade({
      symbol, side: "BUY", price: buyResult.price,
      txHash: buyResult.txHash, time: Date.now(), reason: `AI: ${aiResult.reason}`, pnl: null,
    });

    logger.success(`  Bought ${symbol} @ $${buyResult.price} | tx: ${buyResult.txHash}`);
  }

  // ════════════════════════════════════════
  // 卖出
  // ════════════════════════════════════════
  async function doSell(tokenAddr, reason, pnl) {
    const pos = positions.get(tokenAddr);
    if (!pos) return;

    logger.info(`  Selling ${pos.symbol} — ${reason} (PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%)`);
    const result = await executor.sell(tokenAddr, pos.tokenAmount);

    if (result.success) {
      dashboard.addTrade({
        symbol: pos.symbol, side: "SELL", price: pos.currentPrice, pnl,
        txHash: result.txHash, time: Date.now(), reason,
      });
      logger.success(`  SOLD ${pos.symbol} | ${reason} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% | tx: ${result.txHash}`);
      positions.delete(tokenAddr);
      soldTokens.add(tokenAddr);
      dashboard.removePosition(tokenAddr);
    } else {
      logger.error(`  Sell FAILED for ${pos.symbol}: ${result.error} — will retry next cycle`);
    }
  }

  // ════════════════════════════════════════
  // 价格监控循环 (5 秒)
  // ════════════════════════════════════════
  async function monitorPrices() {
    if (monitorBusy || positions.size === 0) return;
    monitorBusy = true;

    try {
      const entries = [...positions.entries()];
      const results = await Promise.allSettled(
        entries.map(([addr]) => priceWatch.getPrice(addr))
      );

      for (let i = 0; i < entries.length; i++) {
        const [tokenAddr, pos] = entries[i];
        if (!positions.has(tokenAddr)) continue;

        const priceResult = results[i];
        if (priceResult.status !== "fulfilled" || !priceResult.value) continue;

        const data = priceResult.value;
        pos.currentPrice = data.price;
        pos.fdv = data.fdv || pos.fdv;

        if (pos.currentPrice > pos.highestPrice) pos.highestPrice = pos.currentPrice;

        const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.pnl = pnl;

        // ── 激活移动止损 ──
        if (!pos.trailingActive && pnl >= C.TRAILING_ACTIVATE) {
          pos.trailingActive = true;
          logger.info(`${pos.symbol} TRAILING ACTIVATED @ +${pnl.toFixed(1)}%`);
        }

        // ── 移动止损触发 ──
        if (pos.trailingActive) {
          const drawdown = ((pos.highestPrice - pos.currentPrice) / pos.highestPrice) * 100;
          if (drawdown >= C.TRAILING_STOP) {
            logger.warn(`${pos.symbol} TRAILING STOP -${drawdown.toFixed(1)}% from high`);
            await doSell(tokenAddr, "TRAILING_STOP", pnl);
            continue;
          }
        }

        // ── 硬止损 ──
        if (pnl <= -C.HARD_STOP) {
          logger.warn(`${pos.symbol} HARD STOP ${pnl.toFixed(1)}%`);
          await doSell(tokenAddr, "HARD_STOP", pnl);
          continue;
        }

        // 更新 dashboard (无到期时间)
        dashboard.updatePosition(tokenAddr, {
          currentPrice: pos.currentPrice,
          highestPrice: pos.highestPrice,
          pnl,
          trailingActive: pos.trailingActive,
          fdv: pos.fdv,
        });
      }
    } catch (e) {
      logger.error(`monitorPrices error: ${e.message}`);
    } finally {
      monitorBusy = false;
    }
  }

  // ── 启动 ──
  const sniper = new SniperBot(wssProvider, httpProvider, C);
  sniper.on("migration", onMigration);
  sniper.start();

  setInterval(monitorPrices, C.POLL_INTERVAL);

  logger.info(`Price poll interval: ${C.POLL_INTERVAL / 1000}s`);
  logger.info("Bot running. Ctrl+C to stop.");

  // ── 优雅关闭 ──
  async function shutdown() {
    logger.info("Shutting down...");
    sniper.stop();
    xMonitor.stop();
    for (const [addr, pos] of positions) {
      const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      logger.info(`Emergency sell ${pos.symbol}...`);
      await doSell(addr, "SHUTDOWN", pnl);
    }
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (e) => {
    logger.error(`Unhandled rejection: ${e?.message || e}`);
  });
}

main().catch(e => {
  logger.error(`Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
