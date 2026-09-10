const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { unzipSync, strFromU8 } = require("fflate");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-quiz-admin-users-"));
const port = 32000 + crypto.randomInt(1000);
const origin = `http://127.0.0.1:${port}`;
const salt = crypto.randomBytes(16).toString("hex");
const userId = "u_admin_user_test";
const now = new Date().toISOString();

fs.writeFileSync(path.join(dataDir, "quiz-state.json"), JSON.stringify({
  version: 1,
  users: [{
    id: userId,
    teamName: "测试队伍",
    username: "test_team",
    passwordSalt: salt,
    passwordHash: crypto.scryptSync("test123456", salt, 64).toString("hex"),
    createdAt: now
  }],
  questions: [...[1, 2, 3].map((tier) => ({
    id: `q_tier_${tier}`,
    tier,
    type: "single",
    prompt: `${tier}档测试题`,
    options: [{ key: "A", text: "正确答案" }, { key: "B", text: "错误答案" }],
    correctAnswer: "A",
    explanation: "测试解析",
    createdAt: now
  })), {
    id: "q_practical",
    tier: 2,
    type: "practical",
    prompt: "实操题A",
    imageUrl: "",
    options: [],
    correctAnswer: "",
    explanation: "线下评分",
    createdAt: now
  }],
  attempts: [{
    id: "a_admin_user_test",
    userId,
    questionId: "q_test",
    prompt: "测试题目",
    type: "single",
    tier: 2,
    selectedAnswer: "A",
    correctAnswer: "A",
    correct: true,
    points: 2,
    answeredAt: now
  }],
  updatedAt: now
}, null, 2));

const server = spawn(process.execPath, ["quiz-server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, ADMIN_PASSWORD: "test-admin-password" },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverError = "";
server.stderr.on("data", (chunk) => { serverError += chunk; });

async function request(pathname, options = {}, cookie = "") {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return { body, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || cookie };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await request("/api/health");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`临时测试服务启动失败：${serverError}`);
}

(async () => {
  try {
    await waitForServer();
    const userLogin = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "test_team", password: "test123456" })
    });
    const adminLogin = await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: "test-admin-password" })
    });
    const adminCookie = adminLogin.cookie;

    const before = (await request("/api/admin/status", {}, adminCookie)).body;
    assert.strictEqual(before.users.length, 1);
    assert.strictEqual(before.teams.length, 1);
    assert.strictEqual(before.teams[0].claimed, true);
    assert.strictEqual(before.users[0].route, "A");
    assert.deepStrictEqual(
      { teamName: before.users[0].teamName, answered: before.users[0].answered, correct: before.users[0].correct, wrong: before.users[0].wrong, score: before.users[0].score },
      { teamName: "测试队伍", answered: 1, correct: 1, wrong: 0, score: 2 }
    );

    const reset = (await request(`/api/admin/users/${encodeURIComponent(userId)}/reset`, { method: "POST" }, adminCookie)).body;
    assert.strictEqual(reset.removedAttempts, 1);
    const afterReset = (await request("/api/admin/status", {}, adminCookie)).body;
    assert.strictEqual(afterReset.users[0].answered, 0);
    assert.strictEqual(afterReset.users[0].score, 0);

    const deleted = (await request(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" }, adminCookie)).body;
    assert.strictEqual(deleted.removedAttempts, 0);
    const afterDelete = (await request("/api/admin/status", {}, adminCookie)).body;
    assert.strictEqual(afterDelete.users.length, 0);
    assert.strictEqual(afterDelete.teams[0].claimed, false);
    const oldSession = (await request("/api/auth/me", {}, userLogin.cookie)).body;
    assert.strictEqual(oldSession.authenticated, false);

    const imported = (await request("/api/admin/teams/import", {
      method: "POST",
      body: JSON.stringify({ names: "财智先锋队\n乘风破浪队\n财智先锋队\n测试队伍" })
    }, adminCookie)).body;
    assert.strictEqual(imported.imported, 2);
    assert.strictEqual(imported.skipped, 2);

    const available = (await request("/api/teams/available")).body.teams;
    assert.strictEqual(available.length, 3);
    const selectedTeam = available.find((team) => team.name === "财智先锋队");
    assert.ok(selectedTeam);

    const registered = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ teamId: selectedTeam.id, route: "A", username: "finance_team", password: "test123456" })
    });
    assert.strictEqual(registered.body.user.teamName, "财智先锋队");
    assert.strictEqual(registered.body.user.route, "A");

    const routeADashboard = (await request("/api/quiz/dashboard", {}, registered.cookie)).body;
    assert.deepStrictEqual(routeADashboard.tiers.map((item) => item.tier), [1, 2]);
    const incompletePractical = await fetch(`${origin}/api/quiz/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: registered.cookie },
      body: JSON.stringify({ questionId: "q_practical" })
    });
    assert.strictEqual(incompletePractical.status, 400);
    const practicalResult = (await request("/api/quiz/answer", {
      method: "POST",
      body: JSON.stringify({ questionId: "q_practical", completed: true })
    }, registered.cookie)).body;
    assert.strictEqual(practicalResult.completed, true);
    assert.strictEqual(practicalResult.correct, null);
    assert.strictEqual(practicalResult.points, 0);
    assert.deepStrictEqual(
      practicalResult.dashboard.summary,
      { answered: 1, correct: 0, wrong: 0, score: 0 }
    );
    assert.strictEqual(practicalResult.dashboard.history[0].type, "practical");
    assert.strictEqual(practicalResult.dashboard.history[0].correct, null);
    const routeAForbiddenNext = await fetch(`${origin}/api/quiz/next?tier=3`, { headers: { Cookie: registered.cookie } });
    assert.strictEqual(routeAForbiddenNext.status, 403);
    const routeAForbiddenAnswer = await fetch(`${origin}/api/quiz/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: registered.cookie },
      body: JSON.stringify({ questionId: "q_tier_3", answer: "A" })
    });
    assert.strictEqual(routeAForbiddenAnswer.status, 403);
    const routeAAllowed = await fetch(`${origin}/api/quiz/next?tier=1`, { headers: { Cookie: registered.cookie } });
    assert.strictEqual(routeAAllowed.status, 200);

    const duplicateResponse = await fetch(`${origin}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: selectedTeam.id, route: "B", username: "another_team", password: "test123456" })
    });
    assert.strictEqual(duplicateResponse.status, 409);
    const availableAfterClaim = (await request("/api/teams/available")).body.teams;
    assert.strictEqual(availableAfterClaim.some((team) => team.id === selectedTeam.id), false);

    const bTeam = availableAfterClaim.find((team) => team.name === "测试队伍");
    const missingRoute = await fetch(`${origin}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: bTeam.id, username: "missing_route", password: "test123456" })
    });
    assert.strictEqual(missingRoute.status, 400);
    const routeBRegistered = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ teamId: bTeam.id, route: "B", username: "route_b_team", password: "test123456" })
    });
    assert.strictEqual(routeBRegistered.body.user.route, "B");
    const routeBDashboard = (await request("/api/quiz/dashboard", {}, routeBRegistered.cookie)).body;
    assert.deepStrictEqual(routeBDashboard.tiers.map((item) => item.tier), [2, 3]);
    const routeBForbidden = await fetch(`${origin}/api/quiz/next?tier=1`, { headers: { Cookie: routeBRegistered.cookie } });
    assert.strictEqual(routeBForbidden.status, 403);
    const routeBAllowed = await fetch(`${origin}/api/quiz/next?tier=3`, { headers: { Cookie: routeBRegistered.cookie } });
    assert.strictEqual(routeBAllowed.status, 200);

    const templateResponse = await fetch(`${origin}/api/admin/template`, { headers: { Cookie: adminCookie } });
    assert.strictEqual(templateResponse.status, 200);
    const templateBytes = new Uint8Array(await templateResponse.arrayBuffer());
    const templateFiles = unzipSync(templateBytes);
    const templateText = `${strFromU8(templateFiles["xl/worksheets/sheet1.xml"])}\n${strFromU8(templateFiles["xl/worksheets/sheet2.xml"])}`;
    assert.match(templateText, /实操题/);
    assert.doesNotMatch(templateText, /看图纠错/);
    assert.doesNotMatch(templateText, /\/og\.png/);
    const importedTemplate = (await request("/api/admin/import", {
      method: "POST",
      body: JSON.stringify({ filename: "题库导入模板.xlsx", data: Buffer.from(templateBytes).toString("base64"), mode: "append" })
    }, adminCookie)).body;
    assert.strictEqual(importedTemplate.imported, 4);

    const unclaimedTeam = availableAfterClaim.find((team) => team.name === "乘风破浪队");
    const removedTeam = (await request(`/api/admin/teams/${encodeURIComponent(unclaimedTeam.id)}`, { method: "DELETE" }, adminCookie)).body;
    assert.match(removedTeam.message, /乘风破浪队/);

    console.log("队伍导入、唯一引用、A/B路线权限、用户重置删除及会话失效测试通过");
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

