// ============================================================
// X Monitor — 监控 @cz_binance @heyibinance 推文 (v3)
// 功能:
//   1. 每 1 分钟拉取两个账号的最新推文
//   2. 缓存最近 30 分钟内的推文到内存
//   3. 迁移事件发生时，返回 30 分钟内所有推文供 AI 评估关联性
// ============================================================

const { logger } = require("./logger");

// CZ 和何一的 X 用户名
const MONITOR_ACCOUNTS = ["cz_binance", "heyibinance"];

class XMonitor {
  constructor(bearerToken) {
    this.bearer = bearerToken;
    this.base = "https://api.twitter.com/2";

    // 推文缓存: { id, text, authorUsername, createdAt }
    this.tweetCache = [];
    this.cacheTTL = 30 * 60 * 1000; // 30 分钟

    // 各账号的 user id (首次查询时填充)
    this.userIds = new Map();

    // 各账号上次拉取的最新推文 id (since_id)
    this.sinceIds = new Map();

    this._pollTimer = null;
  }

  /**
   * 启动定时拉取 (每 60 秒)
   */
  async start() {
    if (!this.bearer) {
      logger.warn("X_BEARER_TOKEN missing — X monitor disabled");
      return;
    }

    // 先解析 user ids
    await this._resolveUserIds();

    // 立即拉一次
    await this._poll();

    // 每 60 秒拉一次
    this._pollTimer = setInterval(() => this._poll(), 60 * 1000);
    logger.info(`X Monitor started — tracking: ${MONITOR_ACCOUNTS.join(", ")} (poll 60s)`);
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  /**
   * 获取最近 30 分钟内的所有缓存推文 (仅读缓存)
   */
  getRecentTweets() {
    this._pruneCache();
    return [...this.tweetCache];
  }

  /**
   * 立即拉取最新推文并返回 30 分钟内全部缓存
   * 用于迁移事件触发时，确保拿到最新数据
   */
  async fetchLatest() {
    if (!this.bearer || this.userIds.size === 0) {
      return this.getRecentTweets();
    }
    logger.info("X fetchLatest: pulling fresh tweets before AI eval...");
    await this._poll();
    return this.getRecentTweets();
  }

  // ── 解析用户名 → user id ──
  async _resolveUserIds() {
    const usernames = MONITOR_ACCOUNTS.join(",");
    try {
      const url = `${this.base}/users/by?usernames=${usernames}&user.fields=id,username`;
      const resp = await this._fetch(url);
      if (!resp.ok) {
        logger.error(`X resolve userIds: ${resp.status}`);
        return;
      }
      const d = await resp.json();
      if (d.data) {
        for (const u of d.data) {
          this.userIds.set(u.username.toLowerCase(), u.id);
          logger.info(`  X user: @${u.username} → id=${u.id}`);
        }
      }
    } catch (e) {
      logger.error(`X resolveUserIds: ${e.message}`);
    }
  }

  // ── 定时拉取所有账号推文 ──
  async _poll() {
    this._pruneCache();

    for (const username of MONITOR_ACCOUNTS) {
      const userId = this.userIds.get(username.toLowerCase());
      if (!userId) continue;

      try {
        await this._fetchUserTweets(username, userId);
      } catch (e) {
        logger.error(`X poll @${username}: ${e.message}`);
      }
    }

    logger.info(`X cache: ${this.tweetCache.length} tweets in last 30min`);
  }

  // ── 拉取单个用户的最新推文 ──
  async _fetchUserTweets(username, userId) {
    let url = `${this.base}/users/${userId}/tweets?max_results=10&tweet.fields=created_at,text`;

    // 如果有 since_id，只拉新推文
    const sinceId = this.sinceIds.get(userId);
    if (sinceId) {
      url += `&since_id=${sinceId}`;
    } else {
      // 首次拉取: 只拿 30 分钟内的
      const since = new Date(Date.now() - this.cacheTTL).toISOString();
      url += `&start_time=${since}`;
    }

    const resp = await this._fetch(url);

    if (resp.status === 429) {
      logger.warn(`X rate limited for @${username}`);
      return;
    }
    if (!resp.ok) {
      logger.warn(`X fetch @${username}: ${resp.status}`);
      return;
    }

    const d = await resp.json();
    if (!d.data || d.data.length === 0) return;

    // 更新 since_id
    this.sinceIds.set(userId, d.meta?.newest_id || d.data[0].id);

    let added = 0;
    for (const tw of d.data) {
      // 去重
      if (this.tweetCache.some(c => c.id === tw.id)) continue;

      this.tweetCache.push({
        id: tw.id,
        text: tw.text,
        authorUsername: username,
        createdAt: new Date(tw.created_at).getTime(),
      });
      added++;
    }

    if (added > 0) {
      logger.info(`  @${username}: +${added} new tweets`);
    }
  }

  // ── 清理超过 30 分钟的缓存 ──
  _pruneCache() {
    const cutoff = Date.now() - this.cacheTTL;
    this.tweetCache = this.tweetCache.filter(t => t.createdAt >= cutoff);
  }

  async _fetch(url) {
    const headers = { Authorization: `Bearer ${this.bearer}` };
    return fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  }
}

module.exports = { XMonitor };
