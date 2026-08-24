const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const STATE_FILE = path.join(DATA_DIR, "state.json");
const FINISH_BONUSES = [5, 4, 3, 2];
const FINISH_SCORE_TEAM_COUNT = FINISH_BONUSES.length;
const QUIZ_SERVICE_HOSTPORT = String(process.env.QUIZ_SERVICE_HOSTPORT || "").trim();
const QUIZ_TEAMS_URL = String(
  process.env.QUIZ_TEAMS_URL ||
  (QUIZ_SERVICE_HOSTPORT ? `http://${QUIZ_SERVICE_HOSTPORT}/api/integrations/scoreboard/teams` : "")
).trim();
const QUIZ_SYNC_INTERVAL_MS = Math.max(Number(process.env.QUIZ_SYNC_INTERVAL_MS || 15000), 250);
const SCORE_PASSWORDS = {
  A: String(process.env.SCORE_A_PASSWORD || ""),
  B: String(process.env.SCORE_B_PASSWORD || "")
};
const SCORE_AUTH_SECRET = String(process.env.SCORE_AUTH_SECRET || crypto.randomBytes(32).toString("hex"));
const SCORE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const TEAM_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#475569"];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const defaultState = () => ({
  revision: 0,
  updatedAt: new Date().toISOString(),
  teams: []
});

let state = loadState();
const sseClients = new Map();
let quizSyncTimer = null;
let quizSyncRunning = false;
let quizSyncStatus = { enabled: Boolean(QUIZ_TEAMS_URL), lastSuccessAt: null, lastError: null };

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const initial = defaultState();
    saveStateFile(initial);
    return initial;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      revision: Number(parsed.revision || 0),
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      teams: Array.isArray(parsed.teams) ? parsed.teams.map(normalizeTeam) : []
    };
  } catch (error) {
    const backup = `${STATE_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(STATE_FILE, backup);
    console.warn(`成绩数据无法读取，已备份到 ${backup}`);
    const initial = defaultState();
    saveStateFile(initial);
    return initial;
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveStateFile(nextState = state) {
  ensureDataDir();
  const tempFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(nextState, null, 2), "utf8");
  fs.renameSync(tempFile, STATE_FILE);
}

function commit(mutator) {
  mutator(state);
  state.teams = state.teams.map(normalizeTeam);
  state.revision = Number(state.revision || 0) + 1;
  state.updatedAt = new Date().toISOString();
  saveStateFile(state);
  broadcastState();
}

function normalizeTeam(team) {
  const id = team.id || crypto.randomUUID();
  const name = String(team.name || "").trim() || "未命名队伍";
  const scoreEvents = getScoreEvents(team);
  const finishedAt = normalizeDate(team.finishedAt || team.completionTime);

  return {
    id,
    name,
    quizTeamId: String(team.quizTeamId || "").trim(),
    source: team.source === "quiz" || team.quizTeamId ? "quiz" : "manual",
    route: normalizeScoreRoute(team.route || team.scoreRoute || inferTeamRoute(scoreEvents)) || "A",
    order: toNullableNumber(team.order ?? team.drawOrder),
    color: normalizeColor(team.color) || pickColor(id),
    scoreEvents,
    finishedAt,
    finishedBy: String(team.finishedBy || team.completedBy || ""),
    createdAt: team.createdAt || new Date().toISOString(),
    updatedAt: team.updatedAt || latestEventTime(scoreEvents, finishedAt) || new Date().toISOString()
  };
}

function syncedTeamId(quizTeamId) {
  return `quiz_${crypto.createHash("sha256").update(String(quizTeamId)).digest("hex").slice(0, 20)}`;
}

function normalizeSyncedTeam(team) {
  const quizTeamId = String(team?.id || "").trim();
  const name = String(team?.name || "").trim();
  const route = normalizeScoreRoute(team?.route);
  if (!quizTeamId || !name || !route) return null;
  return { quizTeamId, name, route, registeredAt: normalizeDate(team.registeredAt) };
}

async function syncQuizTeams() {
  if (!QUIZ_TEAMS_URL || quizSyncRunning) return;
  quizSyncRunning = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(QUIZ_TEAMS_URL, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`题库同步接口返回 ${response.status}`);
    const payload = await response.json();
    const incoming = (Array.isArray(payload.teams) ? payload.teams : []).map(normalizeSyncedTeam).filter(Boolean);
    const incomingQuizTeamIds = new Set(incoming.map((team) => team.quizTeamId));
    let changed = false;

    for (const item of incoming) {
      let team = state.teams.find((candidate) => candidate.quizTeamId === item.quizTeamId);
      if (!team) {
        const nameKey = item.name.toLocaleLowerCase("zh-CN");
        team = state.teams.find((candidate) => candidate.name.toLocaleLowerCase("zh-CN") === nameKey);
      }

      if (team) {
        if (team.name !== item.name || team.route !== item.route || team.quizTeamId !== item.quizTeamId || team.source !== "quiz") {
          team.name = item.name;
          team.route = item.route;
          team.quizTeamId = item.quizTeamId;
          team.source = "quiz";
          team.updatedAt = new Date().toISOString();
          changed = true;
        }
        continue;
      }

      state.teams.push(normalizeTeam({
        id: syncedTeamId(item.quizTeamId),
        quizTeamId: item.quizTeamId,
        source: "quiz",
        name: item.name,
        route: item.route,
        scoreEvents: [],
        createdAt: item.registeredAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));
      changed = true;
    }

    const staleQuizTeamIds = new Set(
      state.teams
        .filter((team) => team.source === "quiz" && team.quizTeamId && !incomingQuizTeamIds.has(team.quizTeamId))
        .map((team) => team.id)
    );
    if (staleQuizTeamIds.size) {
      state.teams = state.teams.filter((team) => !staleQuizTeamIds.has(team.id));
      changed = true;
    }

    if (changed) commit((draft) => draft.teams.sort(compareTeamDisplay));
    quizSyncStatus = { enabled: true, lastSuccessAt: new Date().toISOString(), lastError: null };
  } catch (error) {
    quizSyncStatus = { enabled: true, lastSuccessAt: quizSyncStatus.lastSuccessAt, lastError: error.name === "AbortError" ? "题库同步超时" : error.message };
    console.warn(`题库队伍同步失败：${quizSyncStatus.lastError}`);
  } finally {
    clearTimeout(timeout);
    quizSyncRunning = false;
  }
}

function getScoreEvents(team) {
  if (Array.isArray(team.scoreEvents)) {
    return team.scoreEvents.map(normalizeScoreEvent).filter(Boolean);
  }

  if (Array.isArray(team.entries)) {
    return team.entries
      .map((entry, index) => {
        const score = Number(entry && entry.score);
        if (!Number.isFinite(score) || score === 0) return null;
        return normalizeScoreEvent({
          id: crypto.randomUUID(),
          points: score,
          operator: entry.updatedBy || "",
          createdAt: entry.updatedAt || team.updatedAt || new Date().toISOString()
        });
      })
      .filter(Boolean);
  }

  return [];
}

function normalizeScoreEvent(event) {
  const points = Number(event.points);
  if (!Number.isFinite(points)) return null;

  return {
    id: event.id || crypto.randomUUID(),
    points: Math.round(points * 100) / 100,
    route: normalizeScoreRoute(event.route || event.sourceRoute),
    operator: String(event.operator || ""),
    createdAt: event.createdAt || new Date().toISOString()
  };
}

function normalizeColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "";
}

function normalizeScoreRoute(value) {
  const route = String(value || "").trim().toUpperCase();
  return ["A", "B"].includes(route) ? route : "";
}

function inferTeamRoute(scoreEvents) {
  const routes = scoreEvents.map((event) => event.route).filter(Boolean);
  if (routes.length && routes.every((route) => route === "B")) return "B";
  if (routes.length && routes.every((route) => route === "A")) return "A";
  return "";
}

function normalizeDate(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function pickColor(seed) {
  const hash = crypto.createHash("md5").update(String(seed)).digest();
  return TEAM_COLORS[hash[0] % TEAM_COLORS.length];
}

function latestEventTime(events, ...extraTimes) {
  return [
    ...events.map((event) => event.createdAt),
    ...extraTimes
  ]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)
    .map((time) => new Date(time).toISOString())[0];
}

function toNullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getPublicState() {
  const totalTeams = state.teams.length;
  const finishInfoById = new Map(
    state.teams
      .filter((team) => team.finishedAt)
      .sort(compareFinish)
      .map((team, index) => [
        team.id,
        {
          finishOrder: index + 1,
          finishScore: FINISH_BONUSES[index] || 0
        }
      ])
  );

  const teams = state.teams.map((team) => {
    const scoreEvents = team.scoreEvents.map(normalizeScoreEvent).filter(Boolean);
    const baseScore = scoreEvents.reduce((sum, event) => sum + event.points, 0);
    const finishInfo = finishInfoById.get(team.id) || null;
    const finishScore = finishInfo ? finishInfo.finishScore : 0;
    const totalScore = baseScore + finishScore;
    const positiveCount = scoreEvents.filter((event) => event.points > 0).length;
    const questionCounts = {
      0: scoreEvents.filter((event) => event.points === 0).length,
      1: scoreEvents.filter((event) => event.points === 1).length,
      2: scoreEvents.filter((event) => event.points === 2).length,
      3: scoreEvents.filter((event) => event.points === 3).length
    };
    const lastScore = scoreEvents.slice().sort(compareEventTimeDesc)[0] || null;

    return {
      ...team,
      scoreEvents,
      baseScore: Math.round(baseScore * 100) / 100,
      questionCounts,
      finishScore,
      finishOrder: finishInfo ? finishInfo.finishOrder : null,
      completed: Boolean(finishInfo),
      totalScore: Math.round(totalScore * 100) / 100,
      scoreCount: scoreEvents.length,
      positiveCount,
      lastScore,
      rank: null,
      routeRank: null
    };
  });

  const ranked = teams.slice().sort(compareRank);
  assignRanks(ranked, "rank");
  ["A", "B"].forEach((route) => {
    assignRanks(
      teams.filter((team) => team.route === route).sort(compareRank),
      "routeRank"
    );
  });

  const rankById = new Map(ranked.map((team) => [team.id, team.rank]));
  teams.forEach((team) => {
    team.rank = rankById.get(team.id);
  });

  return {
    revision: state.revision,
    updatedAt: state.updatedAt,
    totals: {
      teams: totalTeams,
      scoredTeams: teams.filter((team) => team.scoreCount > 0).length,
      completedTeams: teams.filter((team) => team.completed).length,
      finishScoreTeamCount: FINISH_SCORE_TEAM_COUNT,
      finishScoreTotal: teams.reduce((sum, team) => sum + team.finishScore, 0),
      totalScore: Math.round(teams.reduce((sum, team) => sum + team.totalScore, 0) * 100) / 100,
      leadScore: ranked[0] ? ranked[0].totalScore : 0
    },
    teams,
    ranked
  };
}

function getRouteState(route) {
  const publicState = getPublicState();
  const teams = publicState.teams.filter((team) => team.route === route);
  const ranked = publicState.ranked.filter((team) => team.route === route);
  return {
    ...publicState,
    totals: {
      ...publicState.totals,
      teams: teams.length,
      scoredTeams: teams.filter((team) => team.scoreCount > 0).length,
      completedTeams: teams.filter((team) => team.completed).length,
      finishScoreTotal: teams.reduce((sum, team) => sum + team.finishScore, 0),
      totalScore: Math.round(teams.reduce((sum, team) => sum + team.totalScore, 0) * 100) / 100,
      leadScore: ranked[0] ? ranked[0].totalScore : 0
    },
    teams,
    ranked
  };
}

function compareRank(a, b) {
  if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;

  const threePointA = getQuestionCount(a, 3);
  const threePointB = getQuestionCount(b, 3);
  if (threePointB !== threePointA) return threePointB - threePointA;

  const twoPointA = getQuestionCount(a, 2);
  const twoPointB = getQuestionCount(b, 2);
  if (twoPointB !== twoPointA) return twoPointB - twoPointA;

  const finishA = getFinishRankValue(a);
  const finishB = getFinishRankValue(b);
  if (finishA !== finishB) return finishA - finishB;

  const orderA = a.order ?? Number.POSITIVE_INFINITY;
  const orderB = b.order ?? Number.POSITIVE_INFINITY;
  if (orderA !== orderB) return orderA - orderB;

  return a.name.localeCompare(b.name, "zh-CN");
}

function assignRanks(sortedTeams, rankField) {
  let lastRank = 0;
  let lastRankKey = "";

  sortedTeams.forEach((team, index) => {
    const rankKey = getRankTieKey(team);
    const rank = rankKey === lastRankKey ? lastRank : index + 1;
    team[rankField] = rank;
    lastRank = rank;
    lastRankKey = rankKey;
  });
}

function getRankTieKey(team) {
  return [
    team.totalScore,
    getQuestionCount(team, 3),
    getQuestionCount(team, 2),
    getFinishRankValue(team)
  ].join("|");
}

function getQuestionCount(team, points) {
  return Number((team.questionCounts || {})[points] || 0);
}

function getFinishRankValue(team) {
  return team.finishOrder || Number.POSITIVE_INFINITY;
}

function compareTeamDisplay(a, b) {
  const routeCompare = String(a.route || "").localeCompare(String(b.route || ""));
  if (routeCompare !== 0) return routeCompare;

  const orderA = a.order ?? Number.POSITIVE_INFINITY;
  const orderB = b.order ?? Number.POSITIVE_INFINITY;
  if (orderA !== orderB) return orderA - orderB;
  return a.name.localeCompare(b.name, "zh-CN");
}

function compareEventTimeDesc(a, b) {
  return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "");
}

function compareFinish(a, b) {
  const timeA = Date.parse(a.finishedAt || "");
  const timeB = Date.parse(b.finishedAt || "");
  if (timeA !== timeB) return timeA - timeB;

  const orderA = a.order ?? Number.POSITIVE_INFINITY;
  const orderB = b.order ?? Number.POSITIVE_INFINITY;
  if (orderA !== orderB) return orderA - orderB;

  return a.name.localeCompare(b.name, "zh-CN");
}

function broadcastState() {
  const payloads = new Map([["all", JSON.stringify(getPublicState())]]);
  for (const [client, route] of sseClients) {
    try {
      const key = route || "all";
      if (!payloads.has(key)) payloads.set(key, JSON.stringify(getRouteState(route)));
      client.write(`event: state\ndata: ${payloads.get(key)}\n\n`);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("请求内容过大");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .reduce((cookies, entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) return cookies;
      cookies[entry.slice(0, separator).trim()] = decodeURIComponent(entry.slice(separator + 1).trim());
      return cookies;
    }, {});
}

function scoreSessionCookieName() {
  // A browser can only hold one active scoring-desk identity at a time.
  // Signing into the other route overwrites this cookie and invalidates the
  // previous route for that browser.
  return "score_active_session";
}

function signatureFor(value) {
  return crypto.createHmac("sha256", SCORE_AUTH_SECRET).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createScoreSession(route) {
  const payload = Buffer.from(
    JSON.stringify({ route, expiresAt: Date.now() + SCORE_SESSION_TTL_MS, nonce: crypto.randomUUID() })
  ).toString("base64url");
  return `${payload}.${signatureFor(payload)}`;
}

function scoreSession(req, route) {
  const token = parseCookies(req)[scoreSessionCookieName(route)];
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, signatureFor(payload))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.route === route && Number(data.expiresAt) > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function isSecureRequest(req) {
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function scoreSessionSetCookie(req, route) {
  const attributes = [
    `${scoreSessionCookieName(route)}=${createScoreSession(route)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SCORE_SESSION_TTL_MS / 1000)}`
  ];
  if (isSecureRequest(req)) attributes.push("Secure");
  return attributes.join("; ");
}

function hasScoreAccess(req, route) {
  return Boolean(scoreSession(req, route));
}

function requireScoreAccess(req, res, route) {
  if (hasScoreAccess(req, route)) return true;
  sendError(res, 401, `请先登录${route}路线计分台`);
  return false;
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function findTeam(id) {
  return state.teams.find((team) => team.id === id);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      revision: Number(state.revision || 0),
      updatedAt: state.updatedAt,
      uptime: Math.round(process.uptime()),
      quizSync: quizSyncStatus
    });
  }

  if (req.method === "POST" && url.pathname === "/api/score-auth/login") {
    const body = await readJsonBody(req);
    const route = normalizeScoreRoute(body.route);
    const password = String(body.password || "");
    if (!route || !SCORE_PASSWORDS[route]) {
      return sendError(res, 400, "计分台口令尚未配置");
    }
    if (!safeEqual(password, SCORE_PASSWORDS[route])) {
      return sendError(res, 401, "登录口令不正确");
    }
    return sendJson(res, 200, { ok: true, route }, { "Set-Cookie": scoreSessionSetCookie(req, route) });
  }

  if (req.method === "GET" && url.pathname === "/api/score-auth/me") {
    const route = normalizeScoreRoute(url.searchParams.get("route"));
    if (!route) return sendError(res, 400, "请选择A或B路线");
    return sendJson(res, 200, { authenticated: hasScoreAccess(req, route), route });
  }

  if (req.method === "GET" && url.pathname === "/api/score-state") {
    const route = normalizeScoreRoute(url.searchParams.get("route"));
    if (!route) return sendError(res, 400, "请选择A或B路线");
    if (!requireScoreAccess(req, res, route)) return;
    return sendJson(res, 200, getRouteState(route));
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, getPublicState());
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const routeValue = url.searchParams.get("route");
    const route = normalizeScoreRoute(routeValue);
    if (routeValue !== null && !route) return sendError(res, 400, "请选择A或B路线");
    if (route && !requireScoreAccess(req, res, route)) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(": connected\n\n");
    sseClients.set(res, route || "");
    res.write(`event: state\ndata: ${JSON.stringify(route ? getRouteState(route) : getPublicState())}\n\n`);

    const cleanup = () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    };

    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch (error) {
        cleanup();
      }
    }, 25000);

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/teams") {
    return sendError(res, 403, "队伍只能从在线题库同步，计分台不支持手工添加");
  }

  const teamMatch = url.pathname.match(/^\/api\/teams\/([^/]+)$/);
  if (teamMatch && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const team = findTeam(teamMatch[1]);
    if (!team) return sendError(res, 404, "未找到队伍");
    if (!requireScoreAccess(req, res, team.route)) return;
    if (team.source === "quiz" && ["name", "route", "color"].some((field) => body[field] !== undefined)) {
      return sendError(res, 400, "题库同步队伍只能编辑序号，名称和路线请在题库系统中维护");
    }

    commit((draft) => {
      if (body.name !== undefined) team.name = String(body.name || "").trim() || team.name;
      if (body.route !== undefined) team.route = normalizeScoreRoute(body.route) || team.route;
      if (body.order !== undefined) team.order = toNullableNumber(body.order);
      if (body.color !== undefined) team.color = normalizeColor(body.color) || team.color;
      team.updatedAt = new Date().toISOString();
      draft.teams.sort(compareTeamDisplay);
    });

    return sendJson(res, 200, { ok: true });
  }

  if (teamMatch && req.method === "DELETE") {
    const id = teamMatch[1];
    const team = findTeam(id);
    if (!team) return sendError(res, 404, "未找到队伍");
    if (!requireScoreAccess(req, res, team.route)) return;
    if (team.source === "quiz") return sendError(res, 409, "题库同步队伍不能在计分台删除");

    commit((draft) => {
      draft.teams = draft.teams.filter((team) => team.id !== id);
    });

    return sendJson(res, 200, { ok: true });
  }

  const finishMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/finish$/);
  if (finishMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const team = findTeam(finishMatch[1]);
    if (!team) return sendError(res, 404, "未找到队伍");
    if (!requireScoreAccess(req, res, team.route)) return;

    commit(() => {
      const finishedAt = normalizeDate(body.finishedAt) || new Date().toISOString();
      team.finishedAt = team.finishedAt || finishedAt;
      team.finishedBy = String(body.finishedBy || "");
      team.updatedAt = new Date().toISOString();
    });

    return sendJson(res, 200, { ok: true });
  }

  const unfinishMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/unfinish$/);
  if (unfinishMatch && req.method === "POST") {
    const team = findTeam(unfinishMatch[1]);
    if (!team) return sendError(res, 404, "未找到队伍");
    if (!requireScoreAccess(req, res, team.route)) return;

    commit(() => {
      team.finishedAt = null;
      team.finishedBy = "";
      team.updatedAt = new Date().toISOString();
    });

    return sendJson(res, 200, { ok: true });
  }

  const scoreMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/scores$/);
  if (scoreMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const team = findTeam(scoreMatch[1]);
    if (!team) return sendError(res, 404, "未找到队伍");
    if (!requireScoreAccess(req, res, team.route)) return;

    const points = Number(body.points);
    const teamRoute = normalizeScoreRoute(team.route);
    const requestRoute = normalizeScoreRoute(body.route);
    if (!requestRoute || requestRoute !== teamRoute) {
      return sendError(res, 400, `只能在队伍所属的${teamRoute}路线计分台打分`);
    }

    const allowedPoints = teamRoute === "A" ? [1, 2, 0] : [2, 3, 0];
    if (!allowedPoints.includes(points)) {
      return sendError(res, 400, `${teamRoute}路线分值只能是 ${allowedPoints.join("、")}`);
    }

    const event = normalizeScoreEvent({
      id: crypto.randomUUID(),
      points,
      route: teamRoute,
      operator: body.operator,
      createdAt: new Date().toISOString()
    });

    commit(() => {
      team.scoreEvents.push(event);
      team.updatedAt = event.createdAt;
    });

    return sendJson(res, 201, { scoreEvent: event });
  }

  const scoreDeleteMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/scores\/([^/]+)$/);
  if (scoreDeleteMatch && req.method === "DELETE") {
    const team = findTeam(scoreDeleteMatch[1]);
    if (!team) return sendError(res, 404, "未找到队伍");
    if (!requireScoreAccess(req, res, team.route)) return;
    if (!team.scoreEvents.some((event) => event.id === scoreDeleteMatch[2])) {
      return sendError(res, 404, "未找到得分记录");
    }

    commit(() => {
      team.scoreEvents = team.scoreEvents.filter((event) => event.id !== scoreDeleteMatch[2]);
      team.updatedAt = new Date().toISOString();
    });

    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, "接口不存在");
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/rank.html";
  if (pathname === "/rank") pathname = "/rank.html";
  if (pathname === "/score") pathname = "/score-a.html";
  if (pathname === "/score-a") pathname = "/score-a.html";
  if (pathname === "/score-b") pathname = "/score-b.html";
  if (pathname === "/score.html") pathname = "/score-a.html";

  const scoreRoute = pathname === "/score-a.html" ? "A" : pathname === "/score-b.html" ? "B" : "";
  if (scoreRoute && !hasScoreAccess(req, scoreRoute)) {
    return sendRedirect(res, `/score-login.html?route=${scoreRoute}`);
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendError(res, 403, "禁止访问");
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      return sendError(res, 404, "页面不存在");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, error.message || "服务器内部错误");
  }
});

server.listen(PORT, HOST, () => {
  console.log("队伍统分与大屏展示网站已启动");
  console.log(`本机访问: http://localhost:${PORT}`);
  for (const url of getLanUrls()) {
    console.log(`局域网访问: ${url}`);
  }
  if (QUIZ_TEAMS_URL) {
    syncQuizTeams();
    quizSyncTimer = setInterval(syncQuizTeams, QUIZ_SYNC_INTERVAL_MS);
    quizSyncTimer.unref();
  }
});

function getLanUrls() {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const net of Object.values(nets)) {
    for (const item of net || []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`http://${item.address}:${PORT}`);
      }
    }
  }
  return urls;
}
