// ============================================================
// Trade Executor — PancakeSwap via MEV Guard RPC
// v2: 修复 buy 余额差值、sell decimals、卖出重试
// ============================================================

const { ethers } = require("ethers");
const { logger } = require("./logger");

const ROUTER_ABI = [
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
];

const ERC20_ABI = [
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

class TradeExecutor {
  constructor(wallet, config) {
    this.wallet = wallet;
    this.config = config;
    this.router = new ethers.Contract(config.PANCAKE_ROUTER_V2, ROUTER_ABI, wallet);
  }

  async buy(tokenAddress, bnbAmount) {
    try {
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
      const decimals = await tokenContract.decimals().catch(() => 18);

      const balanceBefore = await tokenContract.balanceOf(this.wallet.address).catch(() => 0n);

      const amountIn = ethers.parseEther(bnbAmount.toString());
      const path = [this.config.WBNB, tokenAddress];
      const deadline = Math.floor(Date.now() / 1000) + 300;

      let expectedOut = 0n;
      try {
        const amounts = await this.router.getAmountsOut(amountIn, path);
        expectedOut = amounts[1];
      } catch (_) {
        logger.warn("  getAmountsOut failed, using 0 minOut");
      }

      const minOut = expectedOut * BigInt(100 - this.config.SLIPPAGE_PERCENT) / 100n;

      logger.info(`  BUY ${bnbAmount} BNB → ${tokenAddress.slice(0, 10)}...`);
      logger.info(`  expected=${ethers.formatUnits(expectedOut, decimals)} min=${ethers.formatUnits(minOut, decimals)}`);

      const tx = await this.router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        minOut, path, this.wallet.address, deadline,
        {
          value: amountIn,
          gasPrice: ethers.parseUnits(this.config.GAS_PRICE_GWEI.toString(), "gwei"),
          gasLimit: this.config.GAS_LIMIT,
        },
      );

      logger.info(`  tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt.status === 0) return { success: false, error: "tx reverted" };

      const balanceAfter = await tokenContract.balanceOf(this.wallet.address);
      const received = balanceAfter - balanceBefore;
      const receivedFloat = parseFloat(ethers.formatUnits(received, decimals));
      const price = receivedFloat > 0 ? bnbAmount / receivedFloat : 0;

      return {
        success: true,
        txHash: tx.hash,
        price,
        tokenAmount: received,
        decimals,
      };
    } catch (e) {
      logger.error(`Buy error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async sell(tokenAddress, amount, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = await this._sellOnce(tokenAddress, amount);
      if (result.success) return result;

      if (attempt < retries) {
        logger.warn(`  Sell attempt ${attempt + 1} failed, retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    return { success: false, error: "All sell attempts failed" };
  }

  async _sellOnce(tokenAddress, amount) {
    try {
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
      const decimals = await tokenContract.decimals().catch(() => 18);

      const balance = await tokenContract.balanceOf(this.wallet.address);
      const sellAmount = balance > 0n ? balance : (amount || 0n);

      if (sellAmount === 0n) return { success: false, error: "zero balance" };

      const allowance = await tokenContract.allowance(this.wallet.address, this.config.PANCAKE_ROUTER_V2);
      if (allowance < sellAmount) {
        logger.info(`  Approving router...`);
        const atx = await tokenContract.approve(this.config.PANCAKE_ROUTER_V2, ethers.MaxUint256, {
          gasPrice: ethers.parseUnits(this.config.GAS_PRICE_GWEI.toString(), "gwei"),
          gasLimit: 100000,
        });
        await atx.wait();
      }

      const path = [tokenAddress, this.config.WBNB];
      const deadline = Math.floor(Date.now() / 1000) + 300;

      let expectedOut = 0n;
      try {
        const amounts = await this.router.getAmountsOut(sellAmount, path);
        expectedOut = amounts[1];
      } catch (_) {}

      const minOut = expectedOut * BigInt(100 - this.config.SLIPPAGE_PERCENT) / 100n;

      logger.info(`  SELL ${ethers.formatUnits(sellAmount, decimals)} tokens → BNB`);

      const tx = await this.router.swapExactTokensForETHSupportingFeeOnTransferTokens(
        sellAmount, minOut, path, this.wallet.address, deadline,
        {
          gasPrice: ethers.parseUnits(this.config.GAS_PRICE_GWEI.toString(), "gwei"),
          gasLimit: this.config.GAS_LIMIT,
        },
      );

      logger.info(`  sell tx: ${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt.status === 0) return { success: false, error: "sell reverted" };

      return { success: true, txHash: tx.hash, bnbReceived: ethers.formatEther(expectedOut) };
    } catch (e) {
      logger.error(`Sell error: ${e.message}`);
      if (e.message.includes("TRANSFER_FAILED") || e.message.includes("revert")) {
        logger.error(`  ⚠ Possible honeypot: ${tokenAddress}`);
      }
      return { success: false, error: e.message };
    }
  }
}

module.exports = { TradeExecutor };
