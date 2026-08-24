const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value;
  }
  return true;
}

const hasEnvFile = loadEnvFile(path.join(ROOT, ".env"));
const host = process.env.HOST || "127.0.0.1";
const scoreboardPort = String(process.env.SCOREBOARD_PORT || "3000");
const quizPort = String(process.env.QUIZ_PORT || "3001");
const localOnly = host === "127.0.0.1" || host === "localhost" || host === "::1";

if (!hasEnvFile) {
  console.warn("未找到 .env，正在使用仅限本机的开发默认值。建议复制 .env.example 为 .env 并设置口令。");
}

const commonEnv = { ...process.env, HOST: host };
const quizEnv = {
  ...commonEnv,
  PORT: quizPort,
  DATA_DIR: process.env.QUIZ_DATA_DIR || path.join(ROOT, "data", "quiz"),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123"
};
const scoreboardEnv = {
  ...commonEnv,
  PORT: scoreboardPort,
  DATA_DIR: process.env.SCOREBOARD_DATA_DIR || path.join(ROOT, "data", "scoreboard"),
  QUIZ_TEAMS_URL:
    process.env.QUIZ_TEAMS_URL ||
    `http://127.0.0.1:${quizPort}/api/integrations/scoreboard/teams`,
  QUIZ_SYNC_INTERVAL_MS: process.env.QUIZ_SYNC_INTERVAL_MS || "10000",
  SCORE_A_PASSWORD: process.env.SCORE_A_PASSWORD || "score-a-local",
  SCORE_B_PASSWORD: process.env.SCORE_B_PASSWORD || "score-b-local",
  SCORE_AUTH_SECRET: process.env.SCORE_AUTH_SECRET || "local-development-secret-change-before-sharing"
};

if (!localOnly && (!hasEnvFile || !process.env.SCORE_A_PASSWORD || !process.env.SCORE_B_PASSWORD || !process.env.ADMIN_PASSWORD)) {
  console.error("监听非本机地址时必须在 .env 中设置 SCORE_A_PASSWORD、SCORE_B_PASSWORD 和 ADMIN_PASSWORD。");
  process.exit(1);
}

const children = [];
let stopping = false;

function start(name, script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env,
    stdio: ["inherit", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${name} 已退出（code=${code ?? "null"}, signal=${signal || "none"}），正在停止全部服务。`);
    stopAll(code || 1);
  });
  return child;
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  const timer = setTimeout(() => process.exit(exitCode), 1500);
  timer.unref();
  Promise.all(children.map((child) => new Promise((resolve) => child.once("exit", resolve))))
    .finally(() => process.exit(exitCode));
}

start("题库", "quiz-server.js", quizEnv);
start("计分", "server.js", scoreboardEnv);

console.log("\n两个系统正在启动：");
console.log(`- 在线计分系统：http://localhost:${scoreboardPort}/rank.html`);
console.log(`- A路线计分台：http://localhost:${scoreboardPort}/score-a.html`);
console.log(`- B路线计分台：http://localhost:${scoreboardPort}/score-b.html`);
console.log(`- 在线题库：http://localhost:${quizPort}/`);
console.log(`- 题库管理：http://localhost:${quizPort}/admin.html`);
console.log("按 Ctrl+C 同时停止两个服务。\n");

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
