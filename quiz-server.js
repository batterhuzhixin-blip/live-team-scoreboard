const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { unzipSync, zipSync, strFromU8, strToU8 } = require("fflate");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const STATE_FILE = path.join(DATA_DIR, "quiz-state.json");
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "admin123");
const SESSION_AGE_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();
const adminSessions = new Map();
const authFailures = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

const seedQuestions = [];
const ROUTE_TIERS = { A: [1, 2], B: [2, 3] };

function normalizeRoute(value) {
  const route = cleanText(value).toUpperCase();
  return Object.prototype.hasOwnProperty.call(ROUTE_TIERS, route) ? route : "";
}

function allowedTiersFor(user) {
  return ROUTE_TIERS[normalizeRoute(user?.route)] || ROUTE_TIERS.A;
}

function routeLabel(route) {
  return normalizeRoute(route) === "B" ? "B路线" : "A路线";
}

function makeQuestion(input) {
  const tier = Number(input.tier);
  const prompt = cleanText(input.prompt);
  const type = normalizeQuestionType(input.type) || "single";
  const optionSource = input.options || {};
  const options = type === "practical"
    ? []
    : type === "judgment"
      ? [{ key: "A", text: "正确" }, { key: "B", text: "错误" }]
      : ["A", "B", "C", "D"].map((key) => ({ key, text: cleanText(optionSource[key]) })).filter((option) => option.text);
  const correctAnswer = normalizeAnswer(input.correctAnswer, options, type);
  const fingerprint = `${tier}|${prompt}`;
  return {
    id: `q_${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`,
    tier,
    type,
    prompt,
    options,
    correctAnswer,
    imageUrl: cleanText(input.imageUrl),
    explanation: cleanText(input.explanation) || (type === "practical" ? "本题由现场评委依据纸质材料另行评分。" : "暂无解析"),
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function defaultState() {
  return { version: 3, users: [], teams: [], questions: seedQuestions, attempts: [], updatedAt: new Date().toISOString() };
}

function teamIdForName(name) {
  return `t_${crypto.createHash("sha256").update(cleanText(name).toLocaleLowerCase("zh-CN")).digest("hex").slice(0, 16)}`;
}

function normalizeLoadedState(parsed) {
  const users = Array.isArray(parsed.users) ? parsed.users : [];
  const questions = Array.isArray(parsed.questions) ? parsed.questions : seedQuestions;
  const attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
  const userIds = new Set(users.map((user) => user.id));
  const teams = [];
  const teamNames = new Set();

  if (Array.isArray(parsed.teams)) {
    parsed.teams.forEach((item) => {
      const name = cleanText(item.name);
      const normalizedName = name.toLocaleLowerCase("zh-CN");
      if (!name || teamNames.has(normalizedName)) return;
      teamNames.add(normalizedName);
      teams.push({
        id: cleanText(item.id) || teamIdForName(name),
        name,
        claimedByUserId: userIds.has(item.claimedByUserId) ? item.claimedByUserId : null,
        createdAt: item.createdAt || new Date().toISOString()
      });
    });
  }

  users.forEach((user) => {
    const teamName = cleanText(user.teamName);
    let team = teams.find((item) => item.id === user.teamId);
    if (!team && teamName) team = teams.find((item) =>
      item.name.toLocaleLowerCase("zh-CN") === teamName.toLocaleLowerCase("zh-CN")
      && (!item.claimedByUserId || item.claimedByUserId === user.id)
    );
    if (!team && teamName) {
      const baseId = teamIdForName(teamName);
      const id = teams.some((item) => item.id === baseId)
        ? `t_${crypto.createHash("sha256").update(`${teamName}|${user.id}`).digest("hex").slice(0, 16)}`
        : baseId;
      team = { id, name: teamName, claimedByUserId: null, createdAt: user.createdAt || new Date().toISOString() };
      teams.push(team);
      teamNames.add(teamName.toLocaleLowerCase("zh-CN"));
    }
    if (team) {
      team.claimedByUserId = user.id;
      user.teamId = team.id;
      user.teamName = team.name;
    }
    user.route = normalizeRoute(user.route)
      || (attempts.some((attempt) => attempt.userId === user.id && Number(attempt.tier) === 3) ? "B" : "A");
  });

  return {
    version: 3,
    users,
    teams,
    questions,
    attempts,
    updatedAt: parsed.updatedAt || new Date().toISOString()
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const initial = defaultState();
    saveState(initial);
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return normalizeLoadedState(parsed);
  } catch (error) {
    const backup = `${STATE_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(STATE_FILE, backup);
    console.warn(`题库数据无法读取，已备份到 ${backup}`);
    const initial = defaultState();
    saveState(initial);
    return initial;
  }
}

function saveState(nextState = state) {
  ensureDataDir();
  nextState.updatedAt = new Date().toISOString();
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(nextState, null, 2), "utf8");
  fs.renameSync(temp, STATE_FILE);
}

let state = loadState();

function cleanText(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeQuestionType(value) {
  const type = cleanText(value).toLowerCase().replace(/[\s_-]+/g, "");
  const aliases = {
    single: "single", singlechoice: "single", 单选: "single", 单选题: "single",
    multiple: "multiple", multiplechoice: "multiple", multi: "multiple", 多选: "multiple", 多选题: "multiple",
    judgment: "judgment", truefalse: "judgment", boolean: "judgment", 判断: "judgment", 判断题: "judgment",
    practical: "practical", practicalquestion: "practical", 实操: "practical", 实操题: "practical",
    imagecorrection: "practical", image: "practical", 看图纠错: "practical", 看图纠错题: "practical", 看图: "practical", 纠错: "practical"
  };
  return aliases[type] || "";
}

function normalizeAnswer(value, options, type) {
  if (type === "practical") return "";
  const raw = Array.isArray(value) ? value.map(cleanText) : [cleanText(value)];
  const joined = raw.join(",").trim();
  if (!joined) return "";
  if (type === "judgment") {
    const answer = joined.toLowerCase();
    if (["a", "正确", "对", "是", "√", "true", "yes"].includes(answer)) return "A";
    if (["b", "错误", "错", "否", "×", "false", "no"].includes(answer)) return "B";
  }
  const optionKeys = options.map((option) => option.key);
  const exactOption = options.find((option) => option.text === joined);
  if (exactOption) return exactOption.key;
  let parts = joined.toUpperCase().split(/[,，、;；|/\s]+/).filter(Boolean);
  if (parts.length === 1 && /^[A-D]+$/.test(parts[0])) parts = parts[0].split("");
  const keys = Array.from(new Set(parts.map((part) => {
    const byText = options.find((option) => option.text === part);
    return byText ? byText.key : part;
  }))).filter((key) => optionKeys.includes(key));
  return optionKeys.filter((key) => keys.includes(key)).join(",");
}

function hasInvalidAnswer(value, options, type) {
  if (type === "practical") return false;
  const joined = (Array.isArray(value) ? value.map(cleanText) : [cleanText(value)]).join(",").trim();
  if (!joined) return false;
  if (type === "judgment") return !normalizeAnswer(joined, options, type);
  if (options.some((option) => option.text === joined)) return false;
  let parts = joined.toUpperCase().split(/[,，、;；|/\s]+/).filter(Boolean);
  if (parts.length === 1 && /^[A-D]+$/.test(parts[0])) parts = parts[0].split("");
  return parts.some((part) => !options.some((option) => option.key === part || option.text === part));
}

function questionType(question) {
  return normalizeQuestionType(question.type) || "single";
}

function isMultiAnswerType(type) {
  return type === "multiple";
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

function readJson(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("上传内容过大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error("请求内容格式不正确"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf("=");
      return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

function cookieHeader(req, name, value, maxAgeSeconds) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function newSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_AGE_MS });
  return token;
}

function currentUser(req) {
  const token = parseCookies(req).quiz_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_AGE_MS;
  return state.users.find((user) => user.id === session.userId) || null;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: "请先登录后再答题" });
  return user;
}

function hasAdmin(req) {
  const token = parseCookies(req).quiz_admin;
  const expiresAt = token && adminSessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) adminSessions.delete(token);
    return false;
  }
  adminSessions.set(token, Date.now() + SESSION_AGE_MS);
  return true;
}

function requireAdmin(req, res) {
  if (!hasAdmin(req)) {
    json(res, 401, { error: "请先进行管理员验证" });
    return false;
  }
  return true;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.passwordSalt, 64);
  const stored = Buffer.from(user.passwordHash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function publicUser(user) {
  const route = normalizeRoute(user.route) || "A";
  return { id: user.id, username: user.username, teamName: user.teamName, route, routeLabel: routeLabel(route), createdAt: user.createdAt };
}

function publicAvailableTeams() {
  return state.teams
    .filter((team) => !team.claimedByUserId)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    .map((team) => ({ id: team.id, name: team.name }));
}

function scoreboardTeams() {
  return state.users
    .map((user) => ({
      id: user.teamId || user.id,
      name: user.teamName,
      route: normalizeRoute(user.route) || "A",
      registeredAt: user.createdAt
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function adminTeams() {
  const usersById = new Map(state.users.map((user) => [user.id, user]));
  return state.teams.slice().sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((team) => {
    const user = usersById.get(team.claimedByUserId);
    return {
      id: team.id,
      name: team.name,
      claimed: Boolean(user),
      claimedBy: user ? { id: user.id, username: user.username } : null,
      createdAt: team.createdAt
    };
  });
}

function questionCounts() {
  return [1, 2, 3].map((tier) => ({ tier, total: state.questions.filter((q) => q.tier === tier).length }));
}

function dashboardFor(user) {
  const attempts = state.attempts.filter((attempt) => attempt.userId === user.id);
  const byQuestion = new Map(state.questions.map((question) => [question.id, question]));
  const correct = attempts.filter((attempt) => attempt.correct === true).length;
  const wrong = attempts.filter((attempt) => attempt.correct === false).length;
  const score = attempts.reduce((sum, attempt) => sum + Number(attempt.points || 0), 0);
  const allowedTiers = allowedTiersFor(user);
  const tiers = questionCounts().filter(({ tier }) => allowedTiers.includes(tier)).map(({ tier, total }) => {
    const answered = attempts.filter((attempt) => attempt.tier === tier).length;
    return { tier, points: tier, total, answered, remaining: Math.max(total - answered, 0) };
  });
  const history = attempts.slice().sort((a, b) => Date.parse(b.answeredAt) - Date.parse(a.answeredAt)).slice(0, 30).map((attempt) => ({
    id: attempt.id,
    questionId: attempt.questionId,
    prompt: attempt.prompt || byQuestion.get(attempt.questionId)?.prompt || "已下架题目",
    type: attempt.type ? questionType({ type: attempt.type }) : questionType(byQuestion.get(attempt.questionId) || {}),
    tier: attempt.tier,
    selectedAnswer: attempt.selectedAnswer,
    correctAnswer: attempt.correctAnswer,
    correct: attempt.correct == null ? null : Boolean(attempt.correct),
    points: Number(attempt.points || 0),
    answeredAt: attempt.answeredAt
  }));
  return {
    user: publicUser(user),
    summary: { answered: attempts.length, correct, wrong, score },
    tiers,
    history
  };
}

function adminUserSummary(user) {
  const attempts = state.attempts.filter((attempt) => attempt.userId === user.id);
  const correct = attempts.filter((attempt) => attempt.correct === true).length;
  const wrong = attempts.filter((attempt) => attempt.correct === false).length;
  const score = attempts.reduce((sum, attempt) => sum + Number(attempt.points || 0), 0);
  const lastAnsweredAt = attempts.reduce((latest, attempt) => {
    const answeredAt = cleanText(attempt.answeredAt);
    return !latest || Date.parse(answeredAt) > Date.parse(latest) ? answeredAt : latest;
  }, "");
  return {
    ...publicUser(user),
    answered: attempts.length,
    correct,
    wrong,
    score,
    lastAnsweredAt: lastAnsweredAt || null
  };
}

function invalidateUserSessions(userId) {
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
}

function safeQuestion(question) {
  return {
    id: question.id,
    tier: question.tier,
    type: questionType(question),
    prompt: question.prompt,
    imageUrl: cleanText(question.imageUrl),
    options: Array.isArray(question.options) ? question.options.filter((option) => cleanText(option.text)) : []
  };
}

function normalizeHeader(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && cleanText(row[name])) return row[name];
  }
  return "";
}

async function parseWorkbook(buffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw Object.assign(new Error("无法读取该 Excel 文件，请确认文件没有损坏"), { status: 400 });
  }
  const expandedSize = Object.values(files).reduce((sum, file) => sum + file.length, 0);
  if (expandedSize > 40 * 1024 * 1024) throw Object.assign(new Error("Excel 解压后内容过大"), { status: 400 });
  const sheetName = Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw Object.assign(new Error("Excel 中没有可导入的工作表"), { status: 400 });
  const sharedStrings = parseSharedStrings(files["xl/sharedStrings.xml"]);
  const grid = parseSheetXml(strFromU8(files[sheetName]), sharedStrings);
  const headers = grid[0] || [];
  const rows = grid.slice(1).map((values) => {
    const row = {};
    headers.forEach((header, index) => { if (header) row[header] = values[index] || ""; });
    return row;
  }).filter((row) => Object.values(row).some((value) => cleanText(value)));
  if (!rows.length) throw Object.assign(new Error("Excel 中没有可导入的题目"), { status: 400 });

  const questions = [];
  const errors = [];
  rows.forEach((row, index) => {
    const rowNo = index + 2;
    const rawType = cleanText(normalizeHeader(row, ["题型", "类型", "questionType", "Type"])) || "单选";
    const type = normalizeQuestionType(rawType);
    const tier = Number(normalizeHeader(row, ["档位", "题目档位", "tier", "Tier"]));
    const prompt = cleanText(normalizeHeader(row, ["题目", "题干", "question", "Question"]));
    let options = {
      A: cleanText(normalizeHeader(row, ["选项A", "A", "optionA", "Option A"])),
      B: cleanText(normalizeHeader(row, ["选项B", "B", "optionB", "Option B"])),
      C: cleanText(normalizeHeader(row, ["选项C", "C", "optionC", "Option C"])),
      D: cleanText(normalizeHeader(row, ["选项D", "D", "optionD", "Option D"]))
    };
    if (type === "judgment") options = { A: "正确", B: "错误", C: "", D: "" };
    if (type === "practical") options = { A: "", B: "", C: "", D: "" };
    const optionList = ["A", "B", "C", "D"].map((key) => ({ key, text: options[key] })).filter((option) => option.text);
    const rawAnswer = normalizeHeader(row, ["正确答案", "答案", "answer", "Answer"]);
    const correctAnswer = normalizeAnswer(rawAnswer, optionList, type);
    const imageUrl = cleanText(normalizeHeader(row, ["图片地址", "图片链接", "图片URL", "imageUrl", "Image URL"]));
    const explanation = cleanText(normalizeHeader(row, ["解析", "答案解析", "explanation", "Explanation"]));
    const missing = [];
    if (!type) missing.push("题型必须是单选、多选、判断或实操题");
    if (![1, 2, 3].includes(tier)) missing.push("档位必须是1、2或3");
    if (!prompt) missing.push("题目不能为空");
    if (type !== "judgment" && type !== "practical" && optionList.length < 2) missing.push("至少填写选项A和B");
    if (type !== "judgment" && type !== "practical" && optionList.some((option, optionIndex) => option.key !== String.fromCharCode(65 + optionIndex))) missing.push("选项须从A开始连续填写，不能跳列");
    if (type === "multiple" && correctAnswer.split(",").filter(Boolean).length < 2) missing.push("多选题的正确答案至少包含两项，如A,C");
    if (type && type !== "multiple" && type !== "practical" && correctAnswer.split(",").filter(Boolean).length !== 1) missing.push("该题型只能有一个正确答案");
    if (hasInvalidAnswer(rawAnswer, optionList, type)) missing.push("正确答案中包含不存在的选项");
    if (type !== "practical" && !correctAnswer) missing.push(type === "judgment" ? "判断题答案请填写正确或错误" : "正确答案须使用选项字母，如A或A,C");
    if (missing.length) {
      errors.push(`第${rowNo}行：${missing.join("；")}`);
      return;
    }
    questions.push(makeQuestion({ type, tier, prompt, imageUrl, options, correctAnswer, explanation }));
  });
  if (errors.length) throw Object.assign(new Error(errors.slice(0, 8).join("\n")), { status: 400, details: errors });
  const unique = Array.from(new Map(questions.map((question) => [question.id, question])).values());
  return { questions: unique, skippedDuplicates: questions.length - unique.length };
}

function parseSharedStrings(file) {
  if (!file) return [];
  const xml = strFromU8(file);
  return Array.from(xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi), (match) =>
    Array.from(match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi), (part) => decodeXml(part[1])).join("")
  );
}

function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const values = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = cellMatch[1];
      const content = cellMatch[2];
      const ref = /\br="([A-Z]+)\d+"/i.exec(attrs)?.[1] || "A";
      const column = excelColumnIndex(ref);
      const type = /\bt="([^"]+)"/i.exec(attrs)?.[1] || "n";
      const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(content)?.[1] || "";
      const inlineValue = Array.from(content.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi), (match) => decodeXml(match[1])).join("");
      values[column] = type === "s" ? (sharedStrings[Number(rawValue)] || "") : type === "inlineStr" ? inlineValue : decodeXml(rawValue);
    }
    rows.push(values.map((value) => cleanText(value)));
  }
  return rows;
}

function excelColumnIndex(letters) {
  return String(letters).toUpperCase().split("").reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function decodeXml(value) {
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code[0] === "#") return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[code.toLowerCase()] || entity;
  });
}

function encodeXml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
}

async function buildTemplate() {
  const rows = [
    { 题型: "单选", 档位: 1, 题目: "资产负债表反映企业什么时点的财务状况？", 图片地址: "", 选项A: "某一特定日期", 选项B: "某一会计期间", 选项C: "未来三年", 选项D: "任意日期", 正确答案: "A", 解析: "资产负债表反映企业在某一特定日期的财务状况。" },
    { 题型: "多选", 档位: 2, 题目: "下列哪些属于财务报表？", 图片地址: "", 选项A: "资产负债表", 选项B: "利润表", 选项C: "现金流量表", 选项D: "考勤表", 正确答案: "A,B,C", 解析: "前三项属于企业财务报表。" },
    { 题型: "判断", 档位: 1, 题目: "判断题无需填写选项A至D。", 图片地址: "", 选项A: "", 选项B: "", 选项C: "", 选项D: "", 正确答案: "正确", 解析: "判断题答案填写“正确”或“错误”。" },
    { 题型: "实操题", 档位: 3, 题目: "实操题A", 图片地址: "", 选项A: "", 选项B: "", 选项C: "", 选项D: "", 正确答案: "", 解析: "只需填写题型、档位和题目；纸质材料和现场评分规则另行准备。" }
  ];
  const headers = ["题型", "档位", "题目", "图片地址", "选项A", "选项B", "选项C", "选项D", "正确答案", "解析"];
  const table = [headers, ...rows.map((row) => headers.map((header) => row[header]))];
  const notes = [
    ["项目", "填写规则"],
    ["题型", "填写：单选、多选、判断、实操题。留空时按单选导入，以兼容旧模板。"],
    ["档位", "只能填写1、2或3。单选、多选和判断题答对后按档位得分；实操题只记录完成，不自动计分。"],
    ["选项", "单选、多选至少连续填写A、B；C、D可留空。判断题和实操题的选项全部留空。"],
    ["正确答案", "单选填一个字母；多选用英文逗号分隔，如A,C；判断填正确或错误；实操题留空。"],
    ["图片地址", "实操题无需填写。其他题型如需配图，可填写浏览器能直接访问的http(s)图片链接，或网站public目录下以/开头的路径。"],
    ["导入提示", "示例行请修改或删除后再正式导入。系统会逐行校验并提示问题所在行。"]
  ];
  const buildSheetXml = (sheetTable, widths, filter) => {
    const sheetRows = sheetTable.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${excelColumnName(columnIndex)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ""}><is><t>${encodeXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="26" customHeight="1"' : ""}>${cells}</row>`;
    }).join("");
    const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
    const autoFilter = filter ? `<autoFilter ref="A1:${excelColumnName(sheetTable[0].length - 1)}${sheetTable.length}"/>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData>${autoFilter}</worksheet>`;
  };
  const sheetXml = buildSheetXml(table, [12, 8, 42, 38, 20, 20, 20, 20, 14, 48], true);
  const notesXml = buildSheetXml(notes, [16, 100], false);
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="题库模板" sheetId="1" r:id="rId1"/><sheet name="填写说明" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="等线"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="等线"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173B33"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    "xl/worksheets/sheet1.xml": sheetXml,
    "xl/worksheets/sheet2.xml": notesXml
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])), { level: 6 }));
}

function excelColumnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function isRateLimited(req) {
  const key = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0];
  const now = Date.now();
  const recent = (authFailures.get(key) || []).filter((time) => now - time < 10 * 60 * 1000);
  authFailures.set(key, recent);
  return recent.length >= 10;
}

function recordFailure(req) {
  const key = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0];
  authFailures.set(key, [...(authFailures.get(key) || []), Date.now()]);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, users: state.users.length, questions: state.questions.length, updatedAt: state.updatedAt });
  }
  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = currentUser(req);
    return json(res, 200, { authenticated: Boolean(user), user: user ? publicUser(user) : null });
  }
  if (req.method === "GET" && url.pathname === "/api/teams/available") {
    return json(res, 200, { teams: publicAvailableTeams() });
  }
  if (req.method === "GET" && url.pathname === "/api/integrations/scoreboard/teams") {
    return json(res, 200, { updatedAt: state.updatedAt, teams: scoreboardTeams() });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    if (isRateLimited(req)) return json(res, 429, { error: "尝试次数过多，请稍后再试" });
    const body = await readJson(req);
    const teamId = cleanText(body.teamId);
    const route = normalizeRoute(body.route);
    const username = cleanText(body.username);
    const password = String(body.password || "");
    const team = state.teams.find((item) => item.id === teamId);
    if (!team) return json(res, 400, { error: "请选择管理员预先录入的队伍" });
    if (team.claimedByUserId) return json(res, 409, { error: "该队伍已被其他账号引用，请选择自己的队伍" });
    if (!route) return json(res, 400, { error: "请选择A路线或B路线" });
    if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(username)) return json(res, 400, { error: "账号需为3至24位中文、字母、数字或 _ . -" });
    if (password.length < 6 || password.length > 72) return json(res, 400, { error: "密码需为6至72个字符" });
    if (state.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) return json(res, 409, { error: "该账号已被注册" });
    const passwordData = hashPassword(password);
    const user = {
      id: `u_${crypto.randomUUID()}`,
      teamId: team.id,
      teamName: team.name,
      route,
      username,
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      createdAt: new Date().toISOString()
    };
    state.users.push(user);
    team.claimedByUserId = user.id;
    saveState();
    const token = newSession(user.id);
    return json(res, 201, { user: publicUser(user) }, { "Set-Cookie": cookieHeader(req, "quiz_session", token, SESSION_AGE_MS / 1000) });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (isRateLimited(req)) return json(res, 429, { error: "尝试次数过多，请稍后再试" });
    const body = await readJson(req);
    const username = cleanText(body.username);
    const password = String(body.password || "");
    const user = state.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(password, user)) {
      recordFailure(req);
      return json(res, 401, { error: "账号或密码不正确" });
    }
    const token = newSession(user.id);
    return json(res, 200, { user: publicUser(user) }, { "Set-Cookie": cookieHeader(req, "quiz_session", token, SESSION_AGE_MS / 1000) });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = parseCookies(req).quiz_session;
    if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "quiz_session", "", 0) });
  }
  if (req.method === "GET" && url.pathname === "/api/quiz/dashboard") {
    const user = requireUser(req, res); if (!user) return;
    return json(res, 200, dashboardFor(user));
  }
  if (req.method === "GET" && url.pathname === "/api/quiz/next") {
    const user = requireUser(req, res); if (!user) return;
    const tier = Number(url.searchParams.get("tier"));
    if (![1, 2, 3].includes(tier)) return json(res, 400, { error: "题库档位不正确" });
    if (!allowedTiersFor(user).includes(tier)) return json(res, 403, { error: `${routeLabel(user.route)}只能使用${allowedTiersFor(user).join("档和")}档答题包` });
    const answered = new Set(state.attempts.filter((a) => a.userId === user.id).map((a) => a.questionId));
    const available = state.questions.filter((q) => q.tier === tier && !answered.has(q.id));
    if (!available.length) return json(res, 200, { question: null, message: "这一档题目已经全部答完" });
    const question = available[Math.floor(Math.random() * available.length)];
    return json(res, 200, { question: safeQuestion(question), remaining: available.length });
  }
  if (req.method === "POST" && url.pathname === "/api/quiz/answer") {
    const user = requireUser(req, res); if (!user) return;
    const body = await readJson(req);
    const question = state.questions.find((q) => q.id === cleanText(body.questionId));
    if (!question) return json(res, 404, { error: "该题目不存在或已下架" });
    if (!allowedTiersFor(user).includes(question.tier)) return json(res, 403, { error: `${routeLabel(user.route)}不能回答${question.tier}档题目` });
    const type = questionType(question);
    if (state.attempts.some((attempt) => attempt.userId === user.id && attempt.questionId === question.id)) return json(res, 409, { error: "这道题你已经回答过了" });
    if (type === "practical") {
      if (body.completed !== true) return json(res, 400, { error: "完成实操后请点击“回答完毕”" });
      const attempt = {
        id: `a_${crypto.randomUUID()}`,
        userId: user.id,
        questionId: question.id,
        prompt: question.prompt,
        type,
        tier: question.tier,
        selectedAnswer: "",
        correctAnswer: "",
        correct: null,
        points: 0,
        completed: true,
        answeredAt: new Date().toISOString()
      };
      state.attempts.push(attempt);
      saveState();
      return json(res, 200, {
        completed: true,
        correct: null,
        points: 0,
        selectedAnswer: "",
        correctAnswer: "",
        explanation: question.explanation,
        dashboard: dashboardFor(user)
      });
    }
    const options = Array.isArray(question.options) ? question.options : [];
    if (hasInvalidAnswer(body.answer, options, type)) return json(res, 400, { error: "答案中包含无效选项" });
    const selectedAnswer = normalizeAnswer(body.answer, options, type);
    const selectedKeys = selectedAnswer.split(",").filter(Boolean);
    if (!selectedKeys.length) return json(res, 400, { error: "请至少选择一个答案" });
    if (!isMultiAnswerType(type) && selectedKeys.length !== 1) return json(res, 400, { error: "这道题只能选择一个答案" });
    const correctAnswer = normalizeAnswer(question.correctAnswer, options, type);
    const correct = selectedAnswer === correctAnswer;
    const attempt = {
      id: `a_${crypto.randomUUID()}`,
      userId: user.id,
      questionId: question.id,
      prompt: question.prompt,
      type,
      tier: question.tier,
      selectedAnswer,
      correctAnswer,
      correct,
      points: correct ? question.tier : 0,
      answeredAt: new Date().toISOString()
    };
    state.attempts.push(attempt);
    saveState();
    return json(res, 200, {
      correct,
      points: attempt.points,
      selectedAnswer,
      correctAnswer,
      explanation: question.explanation,
      dashboard: dashboardFor(user)
    });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    if (isRateLimited(req)) return json(res, 429, { error: "尝试次数过多，请稍后再试" });
    const body = await readJson(req);
    const candidate = Buffer.from(String(body.password || ""));
    const expected = Buffer.from(ADMIN_PASSWORD);
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      recordFailure(req);
      return json(res, 401, { error: "管理密码不正确" });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    adminSessions.set(token, Date.now() + SESSION_AGE_MS);
    return json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "quiz_admin", token, SESSION_AGE_MS / 1000) });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    const token = parseCookies(req).quiz_admin;
    if (token) adminSessions.delete(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "quiz_admin", "", 0) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/status") {
    if (!requireAdmin(req, res)) return;
    const counts = questionCounts();
    return json(res, 200, {
      authenticated: true,
      stats: {
        questions: state.questions.length,
        users: state.users.length,
        teams: state.teams.length,
        availableTeams: state.teams.filter((team) => !team.claimedByUserId).length,
        attempts: state.attempts.length,
        tiers: counts
      },
      teams: adminTeams(),
      users: state.users.map(adminUserSummary).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
      questions: state.questions.slice(-12).reverse().map((q) => ({ id: q.id, tier: q.tier, type: questionType(q), prompt: q.prompt, correctAnswer: q.correctAnswer }))
    });
  }
  const resetUserMatch = req.method === "POST" && url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset$/);
  if (resetUserMatch) {
    if (!requireAdmin(req, res)) return;
    const userId = decodeURIComponent(resetUserMatch[1]);
    const user = state.users.find((item) => item.id === userId);
    if (!user) return json(res, 404, { error: "用户不存在或已被删除" });
    const before = state.attempts.length;
    state.attempts = state.attempts.filter((attempt) => attempt.userId !== userId);
    saveState();
    return json(res, 200, {
      message: `已重置“${user.teamName}”的答题记录`,
      removedAttempts: before - state.attempts.length,
      user: adminUserSummary(user)
    });
  }
  const deleteUserMatch = req.method === "DELETE" && url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (deleteUserMatch) {
    if (!requireAdmin(req, res)) return;
    const userId = decodeURIComponent(deleteUserMatch[1]);
    const userIndex = state.users.findIndex((item) => item.id === userId);
    if (userIndex < 0) return json(res, 404, { error: "用户不存在或已被删除" });
    const [user] = state.users.splice(userIndex, 1);
    const before = state.attempts.length;
    state.attempts = state.attempts.filter((attempt) => attempt.userId !== userId);
    const team = state.teams.find((item) => item.id === user.teamId || item.claimedByUserId === userId);
    if (team) team.claimedByUserId = null;
    invalidateUserSessions(userId);
    saveState();
    return json(res, 200, {
      message: `已删除用户“${user.teamName}”`,
      removedAttempts: before - state.attempts.length
    });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/teams/import") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req, 256 * 1024);
    const raw = cleanText(body.names);
    if (!raw) return json(res, 400, { error: "请至少填写一个队伍名称" });
    const names = raw.split(/\r?\n/).map(cleanText).filter(Boolean);
    if (names.length > 500) return json(res, 400, { error: "单次最多导入500个队伍" });
    const invalid = names.filter((name) => name.length < 2 || name.length > 30);
    if (invalid.length) return json(res, 400, { error: `队伍名称需为2至30个字符：${invalid.slice(0, 5).join("、")}` });
    const existing = new Set(state.teams.map((team) => team.name.toLocaleLowerCase("zh-CN")));
    const incoming = new Set();
    const imported = [];
    let skipped = 0;
    names.forEach((name) => {
      const normalizedName = name.toLocaleLowerCase("zh-CN");
      if (existing.has(normalizedName) || incoming.has(normalizedName)) {
        skipped += 1;
        return;
      }
      incoming.add(normalizedName);
      imported.push({ id: teamIdForName(name), name, claimedByUserId: null, createdAt: new Date().toISOString() });
    });
    state.teams.push(...imported);
    if (imported.length) saveState();
    return json(res, 200, {
      message: `成功导入${imported.length}个队伍`,
      imported: imported.length,
      skipped,
      total: state.teams.length,
      available: state.teams.filter((team) => !team.claimedByUserId).length
    });
  }
  const deleteTeamMatch = req.method === "DELETE" && url.pathname.match(/^\/api\/admin\/teams\/([^/]+)$/);
  if (deleteTeamMatch) {
    if (!requireAdmin(req, res)) return;
    const teamId = decodeURIComponent(deleteTeamMatch[1]);
    const teamIndex = state.teams.findIndex((item) => item.id === teamId);
    if (teamIndex < 0) return json(res, 404, { error: "队伍不存在或已被删除" });
    const team = state.teams[teamIndex];
    if (team.claimedByUserId) return json(res, 409, { error: "该队伍已被用户引用，请先删除对应用户" });
    state.teams.splice(teamIndex, 1);
    saveState();
    return json(res, 200, { message: `已删除预设队伍“${team.name}”` });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/template") {
    if (!requireAdmin(req, res)) return;
    const file = await buildTemplate();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[".xlsx"],
      "Content-Disposition": "attachment; filename*=UTF-8''%E9%A2%98%E5%BA%93%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx",
      "Content-Length": file.length,
      "Cache-Control": "no-store"
    });
    return res.end(file);
  }
  if (req.method === "DELETE" && url.pathname === "/api/admin/questions") {
    if (!requireAdmin(req, res)) return;
    const removedQuestions = state.questions.length;
    state.questions = [];
    if (removedQuestions) saveState();
    return json(res, 200, {
      message: removedQuestions ? `已清空题库，共删除${removedQuestions}道题` : "当前题库已经是空的",
      removedQuestions,
      total: 0,
      tiers: questionCounts()
    });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/import") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const filename = cleanText(body.filename);
    if (!/\.xlsx$/i.test(filename)) return json(res, 400, { error: "请上传 .xlsx 格式的 Excel 文件" });
    if (!body.data || typeof body.data !== "string") return json(res, 400, { error: "没有读取到上传文件" });
    const buffer = Buffer.from(body.data, "base64");
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) return json(res, 400, { error: "文件为空或超过8MB" });
    const parsed = await parseWorkbook(buffer);
    const mode = body.mode === "append" ? "append" : "replace";
    if (mode === "replace") {
      state.questions = parsed.questions;
    } else {
      const merged = new Map(state.questions.map((question) => [question.id, question]));
      parsed.questions.forEach((question) => merged.set(question.id, question));
      state.questions = Array.from(merged.values());
    }
    saveState();
    return json(res, 200, {
      message: `成功${mode === "replace" ? "替换" : "导入"}${parsed.questions.length}道题`,
      imported: parsed.questions.length,
      skippedDuplicates: parsed.skippedDuplicates,
      total: state.questions.length,
      tiers: questionCounts()
    });
  }
  return json(res, 404, { error: "接口不存在" });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return json(res, 403, { error: "禁止访问" });
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      json(res, 404, { error: "页面不存在" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (path.basename(filePath) === "index.html") {
      const protocol = cleanText(req.headers["x-forwarded-proto"]).split(",")[0] || (req.socket.encrypted ? "https" : "http");
      const host = cleanText(req.headers["x-forwarded-host"]).split(",")[0] || cleanText(req.headers.host) || `localhost:${PORT}`;
      const content = fs.readFileSync(filePath, "utf8").replaceAll("__SITE_ORIGIN__", `${protocol}://${host}`);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext], "Content-Length": Buffer.byteLength(content), "Cache-Control": "no-cache" });
      return res.end(req.method === "HEAD" ? undefined : content);
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": stats.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "请求方式不支持" });
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "服务器暂时开小差了，请稍后重试", details: error.details });
    else res.end();
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
  for (const [token, expiresAt] of adminSessions) if (expiresAt < now) adminSessions.delete(token);
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`财趣题库已启动：http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) console.warn("当前使用默认管理密码 admin123，正式比赛前请设置 ADMIN_PASSWORD 环境变量。");
});

