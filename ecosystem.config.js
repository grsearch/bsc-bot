// PM2 配置
module.exports = {
  apps: [
    {
      name: "four-meme-sniper",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "2G",
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      min_uptime: "10s",
      listen_timeout: 10000,
    },
  ],
};
