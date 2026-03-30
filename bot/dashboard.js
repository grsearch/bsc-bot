// ============================================================
// Dashboard Server — HTTP API + WebSocket (v2)
// 新增: 静态文件服务，可通过浏览器直接访问 dashboard
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const { logger } = require("./logger");

class Dashboard {
  constructor(port) {
    this.port = port;
    this.clients = new Set();
    this.state = {
      detectedTokens: [],
      activePositions: [],
      tradeHistory: [],
      stats: { detected: 0, qualified: 0, bought: 0, wins: 0, losses: 0, totalPnlBnb: 0 },
      startTime: Date.now(),
    };
  }

  start() {
    const server = http.createServer((req, res) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      // API routes
      if (req.url === "/api/state") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(this.state));
        return;
      }
      if (req.url === "/api/health") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          status: "ok",
          uptime: Math.floor(process.uptime()),
          memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
          positions: this.state.activePositions.length,
          detected: this.state.stats.detected,
        }));
        return;
      }

      // 静态文件服务 (dashboard 前端)
      const publicDir = path.join(__dirname, "..", "public");
      let filePath = path.join(publicDir, req.url === "/" ? "index.html" : req.url);

      // 安全: 防止路径穿越
      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403); res.end("Forbidden"); return;
      }

      const extMap = {
        ".html": "text/html", ".js": "application/javascript",
        ".css": "text/css", ".json": "application/json",
        ".png": "image/png", ".svg": "image/svg+xml",
      };
      const ext = path.extname(filePath);
      const contentType = extMap[ext] || "text/plain";

      fs.readFile(filePath, (err, data) => {
        if (err) {
          // 没有前端文件时返回简易状态页
          if (req.url === "/" || req.url === "/index.html") {
            res.setHeader("Content-Type", "text/html");
            res.end(this._statusPage());
            return;
          }
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.setHeader("Content-Type", contentType);
        res.end(data);
      });
    });

    // WebSocket
    try {
      const { WebSocketServer } = require("ws");
      const wss = new WebSocketServer({ server });
      wss.on("connection", (ws) => {
        this.clients.add(ws);
        logger.info(`Dashboard client connected (${this.clients.size})`);
        ws.send(JSON.stringify({ type: "init", data: this.state }));
        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", () => this.clients.delete(ws));
      });
    } catch (_) {
      logger.warn("ws not installed — dashboard polling only");
    }

    server.listen(this.port, "0.0.0.0", () => {
      logger.info(`Dashboard: http://0.0.0.0:${this.port}`);
      logger.info(`  API:  /api/state  /api/health`);
      logger.info(`  WS:   ws://0.0.0.0:${this.port}`);
    });
  }

  _broadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const c of this.clients) {
      try { if (c.readyState === 1) c.send(msg); }
      catch (_) { this.clients.delete(c); }
    }
  }

  addDetectedToken(token) {
    this.state.detectedTokens.unshift(token);
    if (this.state.detectedTokens.length > 100) this.state.detectedTokens.pop();
    this.state.stats.detected++;
    if (token.qualified) this.state.stats.qualified++;
    this._broadcast("token_detected", token);
  }

  addActivePosition(pos) {
    this.state.activePositions.push(pos);
    this.state.stats.bought++;
    this._broadcast("position_opened", pos);
  }

  updatePosition(addr, updates) {
    const p = this.state.activePositions.find(x => x.tokenAddress === addr);
    if (p) { Object.assign(p, updates); this._broadcast("position_updated", { tokenAddress: addr, ...updates }); }
  }

  removePosition(addr) {
    this.state.activePositions = this.state.activePositions.filter(x => x.tokenAddress !== addr);
    this._broadcast("position_closed", { tokenAddress: addr });
  }

  addTrade(trade) {
    this.state.tradeHistory.unshift(trade);
    if (this.state.tradeHistory.length > 200) this.state.tradeHistory.pop();
    if (trade.side === "SELL" && trade.pnl != null) {
      if (trade.pnl >= 0) this.state.stats.wins++;
      else this.state.stats.losses++;
      this.state.stats.totalPnlBnb += (trade.pnl / 100) * 0.2; // 0.2 BNB per trade
    }
    this._broadcast("trade", trade);
  }

  // 简易状态页 (没有前端文件时显示)
  _statusPage() {
    const s = this.state.stats;
    const up = Math.floor(process.uptime());
    const h = Math.floor(up / 3600);
    const m = Math.floor((up % 3600) / 60);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Four.meme Sniper</title>
<meta http-equiv="refresh" content="5">
<style>
  body{background:#0a0e17;color:#e2e8f0;font-family:'Courier New',monospace;padding:40px;max-width:800px;margin:0 auto}
  h1{color:#00e5ff;border-bottom:1px solid #1e293b;padding-bottom:12px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}
  .card{background:#111827;border:1px solid #1e293b;border-radius:8px;padding:16px}
  .card .label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px}
  .card .value{font-size:28px;font-weight:bold;margin-top:4px}
  .green{color:#00e676} .red{color:#ff5252} .cyan{color:#00e5ff} .dim{color:#64748b}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #1e293b;font-size:13px}
  th{color:#64748b;font-size:11px;text-transform:uppercase}
  a{color:#00e5ff;text-decoration:none}
</style></head><body>
<h1>🎯 Four.meme Sniper Bot</h1>
<p class="dim">Uptime: ${h}h ${m}m | Auto-refresh 5s | <a href="/api/state">API</a></p>
<div class="grid">
  <div class="card"><div class="label">Detected</div><div class="value cyan">${s.detected}</div></div>
  <div class="card"><div class="label">Qualified</div><div class="value green">${s.qualified}</div></div>
  <div class="card"><div class="label">Bought</div><div class="value">${s.bought}</div></div>
  <div class="card"><div class="label">Wins</div><div class="value green">${s.wins}</div></div>
  <div class="card"><div class="label">Losses</div><div class="value red">${s.losses}</div></div>
  <div class="card"><div class="label">PnL (BNB)</div><div class="value ${s.totalPnlBnb >= 0 ? "green" : "red"}">${s.totalPnlBnb >= 0 ? "+" : ""}${s.totalPnlBnb.toFixed(4)}</div></div>
</div>
<h2 style="color:#64748b;font-size:14px">Active Positions (${this.state.activePositions.length})</h2>
<table><thead><tr><th>Token</th><th>Entry</th><th>Current</th><th>PnL</th><th>Trailing</th><th>Remaining</th></tr></thead><tbody>
${this.state.activePositions.map(p => {
  const pnl = p.pnl || 0;
  const rem = p.remainingMinutes != null ? Math.floor(p.remainingMinutes) + "m" : "—";
  return `<tr><td><a href="https://gmgn.ai/bsc/token/${p.tokenAddress}" target="_blank">${p.symbol}</a></td>
    <td>$${p.entryPrice?.toFixed(10) || "—"}</td><td>$${p.currentPrice?.toFixed(10) || "—"}</td>
    <td class="${pnl >= 0 ? "green" : "red"}">${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%</td>
    <td>${p.trailingActive ? '<span class="green">ON</span>' : "—"}</td><td>${rem}</td></tr>`;
}).join("")}
${this.state.activePositions.length === 0 ? '<tr><td colspan="6" class="dim" style="text-align:center">No active positions</td></tr>' : ""}
</tbody></table>
<h2 style="color:#64748b;font-size:14px;margin-top:24px">Recent Trades</h2>
<table><thead><tr><th>Token</th><th>Side</th><th>PnL</th><th>Reason</th><th>Time</th></tr></thead><tbody>
${this.state.tradeHistory.slice(0, 20).map(t => {
  const pc = t.pnl != null ? (t.pnl >= 0 ? "green" : "red") : "dim";
  const pv = t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(1)}%` : "—";
  return `<tr><td>${t.symbol}</td><td class="${t.side === "BUY" ? "green" : "red"}">${t.side}</td>
    <td class="${pc}">${pv}</td><td>${t.reason}</td><td class="dim">${new Date(t.time).toLocaleTimeString()}</td></tr>`;
}).join("")}
${this.state.tradeHistory.length === 0 ? '<tr><td colspan="5" class="dim" style="text-align:center">No trades yet</td></tr>' : ""}
</tbody></table>
</body></html>`;
  }
}

module.exports = { Dashboard };
