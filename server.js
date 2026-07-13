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
const FINISH_SCORE_TEAM_COUNT = 9;

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
const sseClients = new Set();

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
          finishScore: Math.max(FINISH_SCORE_TEAM_COUNT - index, 0)
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

function filterPublicStateByRoute(publicState, route) {
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
  const payload = JSON.stringify(getPublicState());
  for (const client of sseClients) {
    try {
      client.write(`event: state\ndata: ${payload}\n\n`);
    } catch (error) {
      sseClients.delete(client);
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
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

function findTeam(id) {
  return state.teams.find((team) => team.id === id);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      revision: Number(state.revision || 0),
      updatedAt: state.updatedAt,
      uptime: Math.round(process.uptime())
    });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, getPublicState());
  }

  if (req.method === "GET" && url.pathname === "/api/export") {
    const route = normalizeScoreRoute(url.searchParams.get("route"));
    const exportState = route ? filterPublicStateByRoute(getPublicState(), route) : getPublicState();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="scoreboard${route ? `-${route}` : ""}-${new Date().toISOString().slice(0, 10)}.json"`
    });
    return res.end(JSON.stringify(exportState, null, 2));
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(getPublicState())}\n\n`);

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
    const body = await readJsonBody(req);
    const name = String(body.name || "").trim();
    if (!name) return sendError(res, 400, "请填写队伍名称");

    let created;
    commit((draft) => {
      created = normalizeTeam({
        id: crypto.randomUUID(),
        name,
        route: normalizeScoreRoute(body.route) || "A",
        order: toNullableNumber(body.order),
        color: body.color,
        scoreEvents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      draft.teams.push(created);
      draft.teams.sort(compareTeamDisplay);
    });

    return sendJson(res, 201, { team: created });
  }

  const teamMatch = url.pathname.match(/^\/api\/teams\/([^/]+)$/);
  if (teamMatch && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const team = findTeam(teamMatch[1]);
    if (!team) return sendError(res, 404, "未找到队伍");

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
    if (!findTeam(id)) return sendError(res, 404, "未找到队伍");

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

    const points = Number(body.points);
    if (![1, 2, 3].includes(points)) {
      return sendError(res, 400, "分值只能是 1、2、3");
    }

    const event = normalizeScoreEvent({
      id: crypto.randomUUID(),
      points,
      route: body.route,
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
    if (!team.scoreEvents.some((event) => event.id === scoreDeleteMatch[2])) {
      return sendError(res, 404, "未找到得分记录");
    }

    commit(() => {
      team.scoreEvents = team.scoreEvents.filter((event) => event.id !== scoreDeleteMatch[2]);
      team.updatedAt = new Date().toISOString();
    });

    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const body = await readJsonBody(req);
    if (body.confirm !== "RESET") return sendError(res, 400, "确认口令无效");
    const route = normalizeScoreRoute(body.route);

    commit((draft) => {
      draft.teams = route ? draft.teams.filter((team) => team.route !== route) : [];
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
