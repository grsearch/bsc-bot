# Four.meme BSC Migration Sniper Bot

## 架构

```
Alchemy WSS ──→ PairCreated 事件 ──→ 验证 tx.to == Four.meme
                                          │
                                    GoPlus 安全检查
                                    Holders ≥ 20 ?
                                    X Mentions ≥ 5 ?
                                          │ ALL PASS
                                          ▼
                              PancakeSwap Buy 0.2 BNB
                              (via MEV Guard 防三明治)
                                          │
                                          ▼
                              Birdeye 价格轮询 (1s)
                              ┌─ +50% → 激活 trailing stop
                              ├─ 从高点回撤 30% → 卖出
                              ├─ 直接跌 30% → 硬止损
                              ├─ FDV < $20K → 退出
                              └─ 30 分钟到期 → 清仓
```

## 已确认合约

| 合约 | 地址 |
|------|------|
| Four.meme Token Manager | `0x5c952063c7fc8610FFDB798152D69F0B9550762b` |
| PancakeSwap Factory V2 | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| PancakeSwap Router V2 | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| PairCreated topic0 | `0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9` |

## 腾讯云 4C8G 部署步骤

### 1. 服务器环境

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2
sudo npm install -g pm2

# 验证
node -v   # ≥ 18
pm2 -v
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
# PM2 启动（后台运行，崩溃自动重启）
npm run pm2

# 查看日志
npm run pm2:logs

# 查看状态
pm2 status

# 设置开机自启
pm2 save
pm2 startup
```

### 5. 访问 Dashboard

浏览器打开 `http://你的服务器IP:3000`

如需外网访问，记得在腾讯云安全组放开 3000 端口。

## 所需 API Keys

| 服务 | 用途 | 费用 |
|------|------|------|
| Alchemy | BSC WSS 监听 | 免费 |
| Birdeye | 价格/FDV/Holders | $450/月 (B-05) |
| GoPlus | 安全检测 | 免费 |
| Honeypot.is | 二次验证 | 免费 |
| X API v2 | 推文提及量 | Basic $100/月起 |
| BscScan | Holder (备用) | 免费 |
| PancakeSwap MEV Guard | 发送交易 | 免费 |

## 项目结构

```
four-meme-sniper/
├── index.js              # 主入口
├── ecosystem.config.js   # PM2 配置
├── package.json
├── .env.example
├── .gitignore
├── bot/
│   ├── sniper.js         # 迁移事件监听
│   ├── tradeExecutor.js  # 买卖执行
│   ├── priceMonitor.js   # 价格轮询
│   ├── security.js       # 安全检测
│   ├── xMentions.js      # X 提及量
│   ├── dashboard.js      # Web Dashboard
│   └── logger.js         # 日志
└── logs/                 # 日志目录
```

## v2 修复清单

1. **priceMonitor** — `getPrice()` 改用 `token_overview` 端点，同时返回 `price` 和 `fdv`
2. **monitorPrices** — 多持仓时用 `Promise.allSettled` 并行轮询，不再串行阻塞
3. **tradeExecutor buy** — 用买入前后余额差值计算实际收到的 token 数量（旧版用 balanceOf 会算错）
4. **tradeExecutor sell** — 动态获取 decimals（旧版硬编码 18）；内置 2 次重试
5. **index.js doSell** — 卖出失败时不删除持仓，下一轮继续重试
6. **xMentions** — counts 端点返回 403 时自动 fallback 到 search/recent
7. **sniper reconnect** — 加 `_reconnecting` 锁防止心跳和 error 事件同时触发多重重连
8. **dashboard** — 内置 HTML 状态页，浏览器直接访问无需前端构建
9. **全局** — 添加 `unhandledRejection` 捕获、PM2 配置、`.gitignore`

## 安全提示

- 使用**专用热钱包**，只放交易资金
- 先用 0.01 BNB 测试一轮确认正常
- `.env` 永远不要提交到 git
- 建议腾讯云安全组仅允许你的 IP 访问 3000 端口
