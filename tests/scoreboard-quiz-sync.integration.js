const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoreboard-quiz-sync-"));
const quizPort = 33000 + crypto.randomInt(500);
const scorePort = 33500 + crypto.randomInt(500);
const quizTeams = [
  { id: "t_alpha", name: "财智先锋队", route: "A", registeredAt: new Date().toISOString() },
  { id: "t_beta", name: "乘风破浪队", route: "B", registeredAt: new Date().toISOString() }
];

const quizServer = http.createServer((req, res) => {
  if (req.url !== "/api/integrations/scoreboard/teams") {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ updatedAt: new Date().toISOString(), teams: quizTeams }));
});

const scoreServer = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(scorePort),
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    QUIZ_TEAMS_URL: `http://127.0.0.1:${quizPort}/api/integrations/scoreboard/teams`,
    QUIZ_SYNC_INTERVAL_MS: "250",
    SCORE_A_PASSWORD: "A_TEST_PASSWORD",
    SCORE_B_PASSWORD: "B_TEST_PASSWORD",
    SCORE_AUTH_SECRET: "scoreboard-test-session-secret"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverError = "";
const scoreCookies = {};
scoreServer.stderr.on("data", (chunk) => { serverError += chunk; });

async function request(pathname, options = {}) {
  const { scoreRoute, ...requestOptions } = options;
  const response = await fetch(`http://127.0.0.1:${scorePort}${pathname}`, {
    ...requestOptions,
    headers: {
      "Content-Type": "application/json",
      ...(scoreRoute ? { Cookie: scoreCookies[scoreRoute] } : {}),
      ...(requestOptions.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function login(route, password) {
  const response = await fetch(`http://127.0.0.1:${scorePort}/api/score-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route, password })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const state = await request("/api/state");
      if (predicate(state)) return state;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`${message}\n${serverError}`);
}

(async () => {
  try {
    await new Promise((resolve, reject) => {
      quizServer.once("error", reject);
      quizServer.listen(quizPort, "127.0.0.1", resolve);
    });

    const firstState = await waitFor((state) => state.teams.length === 2, "题库队伍未同步到计分系统");
    const routeATeam = firstState.teams.find((team) => team.quizTeamId === "t_alpha");
    const routeBTeam = firstState.teams.find((team) => team.quizTeamId === "t_beta");
    assert.ok(routeATeam);
    assert.ok(routeBTeam);
    assert.strictEqual(routeATeam.route, "A");
    assert.strictEqual(routeBTeam.route, "B");
    assert.strictEqual(routeATeam.source, "quiz");

    const protectedPage = await fetch(`http://127.0.0.1:${scorePort}/score-a.html`, { redirect: "manual" });
    assert.strictEqual(protectedPage.status, 302);
    assert.strictEqual(protectedPage.headers.get("location"), "/score-login.html?route=A");

    const invalidLogin = await fetch(`http://127.0.0.1:${scorePort}/api/score-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "A", password: "错误口令" })
    });
    assert.strictEqual(invalidLogin.status, 401);

  scoreCookies.A = await login("A", "A_TEST_PASSWORD");
  assert.ok(scoreCookies.A.startsWith("score_active_session="));

  const routeABeforeSwitch = await fetch(`http://127.0.0.1:${scorePort}/api/score-state?route=A`, {
    headers: { Cookie: scoreCookies.A },
  });
  assert.equal(routeABeforeSwitch.status, 200);

  scoreCookies.B = await login("B", "B_TEST_PASSWORD");
  assert.ok(scoreCookies.B.startsWith("score_active_session="));

  // The same browser cookie is replaced when the operator signs into B.
  const routeAAfterSwitch = await fetch(`http://127.0.0.1:${scorePort}/api/score-state?route=A`, {
    headers: { Cookie: scoreCookies.B },
  });
  assert.equal(routeAAfterSwitch.status, 401);

  const routeBAfterSwitch = await fetch(`http://127.0.0.1:${scorePort}/api/score-state?route=B`, {
    headers: { Cookie: scoreCookies.B },
  });
  assert.equal(routeBAfterSwitch.status, 200);

    const unauthenticatedRouteState = await fetch(`http://127.0.0.1:${scorePort}/api/score-state?route=A`);
    assert.strictEqual(unauthenticatedRouteState.status, 401);
    const routeAState = await request("/api/score-state?route=A", { scoreRoute: "A" });
    assert.strictEqual(routeAState.teams.length, 1);
    const wrongRouteState = await fetch(`http://127.0.0.1:${scorePort}/api/score-state?route=A`, {
      headers: { Cookie: scoreCookies.B }
    });
    assert.strictEqual(wrongRouteState.status, 401);

    const manualCreate = await fetch(`http://127.0.0.1:${scorePort}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "手工队伍", route: "A" })
    });
    assert.strictEqual(manualCreate.status, 403);

    const exportRemoved = await fetch(`http://127.0.0.1:${scorePort}/api/export?route=A`);
    assert.strictEqual(exportRemoved.status, 404);
    const resetRemoved = await fetch(`http://127.0.0.1:${scorePort}/api/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET", route: "A" })
    });
    assert.strictEqual(resetRemoved.status, 404);

    const renameSynced = await fetch(`http://127.0.0.1:${scorePort}/api/teams/${encodeURIComponent(routeATeam.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: scoreCookies.A },
      body: JSON.stringify({ name: "不应生效的名称" })
    });
    assert.strictEqual(renameSynced.status, 400);

    await request(`/api/teams/${encodeURIComponent(routeATeam.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ order: 7 }),
      scoreRoute: "A"
    });
    const orderedState = await waitFor((state) => state.teams.find((team) => team.id === routeATeam.id)?.order === 7, "同步队伍序号未更新");
    assert.strictEqual(orderedState.teams.find((team) => team.id === routeATeam.id).name, "财智先锋队");

    const deleteSynced = await fetch(`http://127.0.0.1:${scorePort}/api/teams/${encodeURIComponent(routeATeam.id)}`, {
      method: "DELETE",
      headers: { Cookie: scoreCookies.A }
    });
    assert.strictEqual(deleteSynced.status, 409);

    await request(`/api/teams/${encodeURIComponent(routeATeam.id)}/scores`, {
      method: "POST",
      body: JSON.stringify({ points: 2, route: "A", operator: "测试员" }),
      scoreRoute: "A"
    });

    const invalidAThree = await fetch(`http://127.0.0.1:${scorePort}/api/teams/${encodeURIComponent(routeATeam.id)}/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: scoreCookies.A },
      body: JSON.stringify({ points: 3, route: "A" })
    });
    assert.strictEqual(invalidAThree.status, 400);

    const wrongRoute = await fetch(`http://127.0.0.1:${scorePort}/api/teams/${encodeURIComponent(routeATeam.id)}/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: scoreCookies.A },
      body: JSON.stringify({ points: 2, route: "B" })
    });
    assert.strictEqual(wrongRoute.status, 400);

    const invalidBOne = await fetch(`http://127.0.0.1:${scorePort}/api/teams/${encodeURIComponent(routeBTeam.id)}/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: scoreCookies.B },
      body: JSON.stringify({ points: 1, route: "B" })
    });
    assert.strictEqual(invalidBOne.status, 400);

    for (const points of [0, 2, 3]) {
      await request(`/api/teams/${encodeURIComponent(routeBTeam.id)}/scores`, {
        method: "POST",
        body: JSON.stringify({ points, route: "B", operator: "测试员" }),
        scoreRoute: "B"
      });
    }
    const scoredBState = await request("/api/state");
    const scoredBTeam = scoredBState.teams.find((team) => team.id === routeBTeam.id);
    assert.strictEqual(scoredBTeam.baseScore, 5);
    assert.strictEqual(scoredBTeam.scoreCount, 3);
    assert.strictEqual(scoredBTeam.positiveCount, 2);
    assert.strictEqual(scoredBTeam.questionCounts[0], 1);
    assert.strictEqual(scoredBTeam.questionCounts[2], 1);
    assert.strictEqual(scoredBTeam.questionCounts[3], 1);

    quizTeams[0] = { ...quizTeams[0], name: "财智先锋一队", route: "B" };
    const updatedState = await waitFor((state) => {
      const team = state.teams.find((item) => item.quizTeamId === "t_alpha");
      return team && team.name === "财智先锋一队" && team.route === "B";
    }, "题库队伍更新未同步到计分系统");
    const updatedTeam = updatedState.teams.find((team) => team.quizTeamId === "t_alpha");
    assert.strictEqual(updatedTeam.id, routeATeam.id);
    assert.strictEqual(updatedTeam.order, 7);
    assert.strictEqual(updatedTeam.baseScore, 2);
    assert.strictEqual(updatedTeam.scoreEvents.length, 1);

    quizTeams.push(
      { id: "t_gamma", name: "第三队", route: "A", registeredAt: new Date().toISOString() },
      { id: "t_delta", name: "第四队", route: "B", registeredAt: new Date().toISOString() },
      { id: "t_epsilon", name: "第五队", route: "A", registeredAt: new Date().toISOString() }
    );
    const finishState = await waitFor((state) => state.teams.length === 5, "用于完赛加分测试的队伍未同步");
    const finishOrder = ["t_beta", "t_alpha", "t_gamma", "t_delta", "t_epsilon"];
    for (const quizTeamId of finishOrder) {
      const team = finishState.teams.find((item) => item.quizTeamId === quizTeamId);
      await request(`/api/teams/${encodeURIComponent(team.id)}/finish`, {
        method: "POST",
        body: JSON.stringify({}),
        scoreRoute: team.route
      });
    }
    const finishedState = await request("/api/state");
    assert.strictEqual(finishedState.totals.finishScoreTeamCount, 4);
    assert.strictEqual(finishedState.totals.finishScoreTotal, 14);
    assert.deepStrictEqual(
      finishOrder.map((quizTeamId) => finishedState.teams.find((team) => team.quizTeamId === quizTeamId).finishScore),
      [5, 4, 3, 2, 0]
    );

    quizTeams.splice(0, 1);
    const afterQuizDelete = await waitFor(
      (state) => !state.teams.some((team) => team.quizTeamId === "t_alpha"),
      "题库删除的队伍未从计分系统同步移除"
    );
    assert.ok(!afterQuizDelete.teams.some((team) => team.quizTeamId === "t_alpha"));

    const health = await request("/api/health");
    assert.strictEqual(health.quizSync.enabled, true);
    assert.ok(health.quizSync.lastSuccessAt);
    assert.strictEqual(health.quizSync.lastError, null);

    console.log("题库队伍按 A/B 路线同步新增、更新和删除测试通过");
  } finally {
    scoreServer.kill();
    quizServer.close();
    await new Promise((resolve) => scoreServer.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
