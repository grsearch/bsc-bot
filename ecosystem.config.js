// PM2 配置 — 腾讯云 4C8G 服务器
module.exports = {
  apps: [
    {
      name: "four-meme-sniper",
      script: "index.js",
      cwd: __dirname,
      instances: 1,                // 单实例（不能多实例，会重复买入）
      exec_mode: "fork",
      max_memory_restart: "2G",    // 内存超 2G 自动重启
      autorestart: true,
      watch: false,                // 生产环境不要 watch
      max_restarts: 50,
      restart_delay: 5000,         // 重启间隔 5 秒
      env: {
        NODE_ENV: "production",
      },
      // 日志
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      // 崩溃保护
      min_uptime: "10s",
      listen_timeout: 10000,
    },
  ],
};
