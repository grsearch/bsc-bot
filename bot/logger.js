const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, `bot-${new Date().toISOString().split("T")[0]}.log`);

const C = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

function ts() { return new Date().toISOString().replace("T", " ").slice(0, 23); }

function write(level, msg) {
  try { fs.appendFileSync(logFile, `[${ts()}] [${level}] ${msg}\n`); } catch (_) {}
}

const logger = {
  info(m)    { console.log(`${C.dim}${ts()}${C.reset} ${C.cyan}[INFO]${C.reset}  ${m}`);   write("INFO", m); },
  warn(m)    { console.log(`${C.dim}${ts()}${C.reset} ${C.yellow}[WARN]${C.reset}  ${m}`);  write("WARN", m); },
  error(m)   { console.log(`${C.dim}${ts()}${C.reset} ${C.red}[ERROR]${C.reset} ${m}`);     write("ERROR", m); },
  success(m) { console.log(`${C.dim}${ts()}${C.reset} ${C.green}[OK]${C.reset}    ${m}`);   write("OK", m); },
};

module.exports = { logger };
