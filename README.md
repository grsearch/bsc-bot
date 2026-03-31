# Four.meme BSC Migration Sniper Bot v3

## 策略架构

```
Alchemy WSS ──→ PairCreated 事件 ──→ 验证 tx.to == Four.meme
                                          │
                                    GoPlus 安全检查
                                          │ PASS
                                          ▼
                              获取 30 分钟内 CZ/何一推文缓存
                              DeepSeek AI 评估代币与推文关联性
                              (confidence ≥ 60% → 通过)
                                          │ PASS
                                          ▼
                              PancakeSwap Buy 0.2 BNB
                              (via MEV Guard 防三明治)
                                          │
                                          ▼
                              Birdeye 价格轮询 (5s)
                              ┌─ +50% → 激活 trailing stop
                              ├─ 从高点回撤 30% → 卖出
                              └─ 直接跌 30% → 硬止损

  X Monitor (独立循环，每 60s):
  ┌─ 拉取 @cz_binance 最新推文
  ├─ 拉取 @heyibinance 最新推文
  └─ 缓存到内存 (保留 30 分钟)
```

## v2 → v3 变更

| 变更项 | v2 | v3 |
|--------|----|----|
| 过滤: holders | ≥ 20 | **已移除** |
| 过滤: X 提及量 | 合约地址被提及 ≥ 5 次 | **已移除** |
| 过滤: AI 关联评估 | 无 | **新增** DeepSeek 评估 |
| X 监控 | 搜索合约地址提及 | **改为** 监控 CZ/何一账号推文 |
| 代理 | 支持 Webshare 代理 | **已移除** |
| 价格轮询 | 1 秒 | **5 秒** |
| 监控到期 | 30 分钟自动清仓 | **已移除** (无限持仓) |
| FDV 退出 | FDV < $20K 退出 | **已移除** |

## 已确认合约

| 合约 | 地址 |
|------|------|
| Four.meme Token Manager | `0x5c952063c7fc8610FFDB798152D69F0B9550762b` |
| PancakeSwap Factory V2 | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| PancakeSwap Router V2 | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |

## 部署步骤

### 1. 服务器环境

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

### 2. 部署代码

```bash
cd /opt
git clone https://github.com/YOUR_USER/four-meme-sniper.git
cd four-meme-sniper
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
nano .env
# 填入所有 API keys 和钱包私钥
```

### 4. 启动

```bash
npm run pm2
pm2 logs four-meme-sniper
pm2 save && pm2 startup
```

### 5. 访问 Dashboard

浏览器打开 `http://你的服务器IP:3000`

## 所需 API Keys

| 服务 | 用途 | 费用 |
|------|------|------|
| Alchemy | BSC WSS 监听 | 免费 |
| Birdeye | 价格/FDV | $450/月 (B-05) |
| GoPlus | 安全检测 | 免费 |
| Honeypot.is | 二次验证 | 免费 |
| X API v2 | 监控 CZ/何一推文 | Basic $100/月起 |
| DeepSeek | AI 关联性评估 | 按用量计费 |
| BscScan | Holder 查询 (展示用) | 免费 |
| PancakeSwap MEV Guard | 发送交易 | 免费 |

## 项目结构

```
four-meme-sniper/
├── index.js              # 主入口 (v3)
├── ecosystem.config.js   # PM2 配置
├── package.json
├── .env.example
├── .gitignore
├── bot/
│   ├── sniper.js         # 迁移事件监听
│   ├── tradeExecutor.js  # 买卖执行
│   ├── priceMonitor.js   # 价格轮询 (5s)
│   ├── security.js       # 安全检测
│   ├── xMentions.js      # X Monitor (CZ/何一推文)
│   ├── deepseekEval.js   # DeepSeek AI 关联评估
│   ├── dashboard.js      # Web Dashboard
│   └── logger.js         # 日志
└── logs/
```

## 安全提示

- 使用**专用热钱包**，只放交易资金
- 先用 0.01 BNB 测试一轮确认正常
- `.env` 永远不要提交到 git
- 建议安全组仅允许你的 IP 访问 3000 端口
