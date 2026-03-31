// ============================================================
// DeepSeek Relevance Evaluator
// 用 DeepSeek API 评估迁移代币与 CZ/何一 推文的关联性
// ============================================================

const { logger } = require("./logger");

class DeepSeekEvaluator {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.base = "https://api.deepseek.com/v1";
  }

  /**
   * 评估代币与推文的关联性
   * @param {string} tokenAddress - 代币合约地址
   * @param {string} tokenSymbol  - 代币符号 (如 "PEPE")
   * @param {Array}  tweets       - 最近 30 分钟的推文列表
   * @returns {{ relevant: boolean, reason: string, confidence: number }}
   */
  async evaluate(tokenAddress, tokenSymbol, tweets) {
    if (!this.apiKey) {
      logger.warn("DEEPSEEK_API_KEY missing — skip AI evaluation");
      return { relevant: false, reason: "no API key", confidence: 0 };
    }

    if (!tweets || tweets.length === 0) {
      return { relevant: false, reason: "no recent tweets", confidence: 0 };
    }

    // 构造推文摘要
    const tweetSummary = tweets.map((t, i) =>
      `[${i + 1}] @${t.authorUsername} (${new Date(t.createdAt).toISOString()}): ${t.text}`
    ).join("\n");

    const prompt = `你是一个加密货币分析专家。你的任务是判断一个新上线的 meme coin 是否与以下 KOL 推文内容相关。

代币信息:
- 合约地址: ${tokenAddress}
- 代币符号: ${tokenSymbol}

以下是 @cz_binance (币安创始人CZ) 和 @heyibinance (何一) 最近 30 分钟内的推文:
${tweetSummary}

判断标准:
1. 直接匹配: 推文中是否直接提到了该代币名称、符号或合约地址
2. 主题关联: 推文中是否提到了与该代币名称/主题高度相关的关键词（如代币叫 "CatCoin" 而推文在讨论猫）
3. 概念匹配: 推文中是否暗示了某个 meme 概念且该代币正好匹配该概念
4. 蹭梗/谐音/变体: 代币名称是否蹭了推文中的热词或梗，包括但不限于:
   - 谐音梗（如推文说 "safe" → 代币叫 "SAFU"）
   - 拼写变体（如推文说 "moon" → 代币叫 "M00N" 或 "MOONN"）
   - 缩写/首字母组合（如推文说 "Build and HODL" → 代币叫 "BAH"）
   - 推文中某个词的 meme 化变体（如 "CZ" → "CZDOG", "CZBABY"）
   - 中英文谐音（如推文说 "发" → 代币叫 "FA" 或 "888"）
5. 排除项: 仅仅是一般性的加密货币讨论（如"看好加密未来"、"GM"、"WAGMI"）不构成关联

请用以下 JSON 格式回复（不要包含其他任何内容）:
{
  "relevant": true/false,
  "confidence": 0-100,
  "reason": "简短解释为什么相关或不相关"
}`;

    try {
      const resp = await fetch(`${this.base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 200,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        logger.error(`DeepSeek API ${resp.status}: ${errText}`);
        return { relevant: false, reason: `API error ${resp.status}`, confidence: 0 };
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || "";

      // 解析 JSON 回复
      const cleaned = content.replace(/```json\s*/g, "").replace(/```/g, "").trim();
      const result = JSON.parse(cleaned);

      logger.info(`DeepSeek eval: relevant=${result.relevant} confidence=${result.confidence} reason=${result.reason}`);
      return {
        relevant: !!result.relevant,
        reason: result.reason || "",
        confidence: result.confidence || 0,
      };
    } catch (e) {
      logger.error(`DeepSeek evaluate error: ${e.message}`);
      return { relevant: false, reason: `error: ${e.message}`, confidence: 0 };
    }
  }
}

module.exports = { DeepSeekEvaluator };
