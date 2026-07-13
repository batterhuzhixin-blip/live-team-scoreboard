const page = document.body.dataset.page;
const scoreRoute = document.body.dataset.scoreRoute || "";
let currentState = null;
let staffName = localStorage.getItem("scorekeeperName") || "";
let eventsConnection = null;
let pollTimer = null;
let renderFrame = null;

const quickScores = [
  { label: "加 1 分", points: 1 },
  { label: "加 2 分", points: 2 },
  { label: "加 3 分", points: 3 }
];

document.addEventListener("DOMContentLoaded", () => {
  if (page === "score") initScorePage();
  connectEvents();
  fetchState();
});

function initScorePage() {
  const staffInput = document.querySelector("#staffName");
  staffInput.value = staffName;
  staffInput.addEventListener("input", () => {
    staffName = staffInput.value.trim();
    localStorage.setItem("scorekeeperName", staffName);
  });

  document.querySelector("#teamForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    await api("/api/teams", {
      method: "POST",
      body: {
        name: formData.get("name"),
        route: scoreRoute,
        order: formData.get("order")
      }
    });
    form.reset();
    toast("队伍已添加");
  });

  document.querySelector("#teamsList").addEventListener("click", onTeamsListClick);

  document.querySelector("#exportBtn").addEventListener("click", () => {
    const routeQuery = scoreRoute ? `?route=${encodeURIComponent(scoreRoute)}` : "";
    window.open(`/api/export${routeQuery}`, "_blank");
  });

  document.querySelector("#resetBtn").addEventListener("click", async () => {
    const ok = window.confirm(`确定清空${scoreRoute || "当前"}路线的所有队伍和得分记录吗？`);
    if (!ok) return;
    await api("/api/reset", {
      method: "POST",
      body: { confirm: "RESET", route: scoreRoute }
    });
    toast(`${scoreRoute || "当前"}路线成绩已清空`);
  });
}

function connectEvents() {
  closeEvents();

  if (!window.EventSource) {
    setConnection(false);
    pollTimer = setInterval(fetchState, 3000);
    return;
  }

  eventsConnection = new EventSource("/api/events");
  eventsConnection.addEventListener("open", () => setConnection(true));
  eventsConnection.addEventListener("error", () => setConnection(false));
  eventsConnection.addEventListener("state", (event) => {
    currentState = JSON.parse(event.data);
    setConnection(true);
    scheduleRender();
  });
}

function closeEvents() {
  if (eventsConnection) {
    eventsConnection.close();
    eventsConnection = null;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

window.addEventListener("pagehide", closeEvents);
window.addEventListener("beforeunload", closeEvents);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    closeEvents();
  } else if (!eventsConnection && !pollTimer) {
    connectEvents();
    fetchState();
  }
});

async function fetchState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    currentState = await response.json();
    scheduleRender();
  } catch (error) {
    setConnection(false);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    toast(data.error || "操作失败");
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function render() {
  if (!currentState) return;
  if (page === "score") renderScorePage();
  if (page === "rank") renderRankPage();
}

function scheduleRender() {
  if (renderFrame) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = null;
    render();
  });
}

function renderScorePage() {
  renderScoreSummary();
  renderTeams();
  renderScoreRankList();
}

function renderScoreSummary() {
  const teamCountText = document.querySelector("#teamCountText");
  if (teamCountText) teamCountText.textContent = `${getScoreTeams().length} 支队伍`;
}

function renderTeams() {
  const list = document.querySelector("#teamsList");
  list.innerHTML = "";
  const teams = getScoreTeams();

  if (!teams.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = `暂无${scoreRoute || ""}路线队伍`;
    list.appendChild(empty);
    return;
  }

  teams
    .slice()
    .sort(compareTeamDisplay)
    .forEach((team) => list.appendChild(teamCard(team)));
}

function getScoreTeams() {
  if (!scoreRoute) return currentState.teams;
  return currentState.teams.filter((team) => team.route === scoreRoute);
}

function teamCard(team) {
  const article = document.createElement("article");
  article.className = "team-card";
  article.dataset.teamId = team.id;
  article.style.setProperty("--team-color", team.color);

  const scoreEvents = team.scoreEvents.slice().sort(compareEventTimeDesc);

  article.innerHTML = `
    <div class="team-card-head">
      <div class="team-title-block">
        <div class="team-title-line">
          <span class="rank-badge">${getDisplayRank(team)}</span>
          <h3>${escapeHtml(team.name)}</h3>
        </div>
        <div class="team-meta">
          <span>序号 ${team.order ?? "--"}</span>
          <span>${team.scoreCount} 条记录</span>
          <span>${team.completed ? `完赛第 ${team.finishOrder}` : "未完赛"}</span>
        </div>
      </div>
      <div class="score-total">
        <span>总分</span>
        <strong>${formatScore(team.totalScore)}</strong>
        <em>加分 ${formatScore(team.baseScore)} + 完赛 ${formatScore(team.finishScore)}</em>
      </div>
      <div class="team-actions">
        ${
          team.completed
            ? '<button type="button" class="warn-btn" data-action="unfinish-team">撤回完赛</button>'
            : '<button type="button" class="primary-btn" data-action="finish-team">完赛</button>'
        }
        <button type="button" class="ghost-btn" data-action="edit-team">编辑</button>
        <button type="button" class="danger-ghost-btn" data-action="delete-team">删除</button>
      </div>
    </div>

    <div class="question-counts" aria-label="答对题型统计">
      <div class="question-count-item">
        <span>1分题</span>
        <strong>${questionCount(team, 1)}</strong>
      </div>
      <div class="question-count-item">
        <span>2分题</span>
        <strong>${questionCount(team, 2)}</strong>
      </div>
      <div class="question-count-item">
        <span>3分题</span>
        <strong>${questionCount(team, 3)}</strong>
      </div>
    </div>

    <div class="score-entry-panel">
      <div class="quick-score-row">
        ${quickScores
          .map(
            (item) => `
              <button type="button" class="quick-plus"
                data-action="quick-score" data-points="${item.points}">
                ${item.label}
              </button>
            `
          )
          .join("")}
      </div>
    </div>

    <div class="score-history">
      ${
        scoreEvents.length
          ? scoreEvents.map((event) => scoreEventRow(event)).join("")
          : '<div class="empty-state small">暂无得分</div>'
      }
    </div>
  `;

  return article;
}

function scoreEventRow(event) {
  const operator = event.operator ? `<span>${escapeHtml(event.operator)}</span>` : "";
  const route = event.route ? `<span class="score-event-route route-${event.route.toLowerCase()}">${escapeHtml(event.route)}路线</span>` : "";

  return `
    <div class="score-event is-plus">
      <div>
        ${route}
        <span>${formatTime(event.createdAt)}</span>
        ${operator}
      </div>
      <b>${formatSignedScore(event.points)}</b>
      <button type="button" class="ghost-btn icon-btn" title="撤销" data-action="delete-score" data-score-id="${event.id}">×</button>
    </div>
  `;
}

function questionCount(team, points) {
  return Number((team.questionCounts || {})[points] || 0);
}

function getDisplayRank(team) {
  return scoreRoute ? team.routeRank || "--" : team.rank || "--";
}

async function onTeamsListClick(event) {
  const button = event.target.closest("button");
  if (!button) return;
  const card = button.closest("[data-team-id]");
  if (!card) return;
  const team = currentState.teams.find((item) => item.id === card.dataset.teamId);
  if (!team) return;

  const action = button.dataset.action;
  if (action === "quick-score") {
    await addScore(team.id, Number(button.dataset.points));
    return;
  }

  if (action === "delete-score") {
    const ok = window.confirm("撤销这条得分记录吗？");
    if (!ok) return;
    await api(`/api/teams/${team.id}/scores/${button.dataset.scoreId}`, { method: "DELETE" });
    toast("得分记录已撤销");
    return;
  }

  if (action === "delete-team") {
    const ok = window.confirm(`删除 ${team.name} 以及全部得分记录吗？`);
    if (!ok) return;
    await api(`/api/teams/${team.id}`, { method: "DELETE" });
    toast("队伍已删除");
    return;
  }

  if (action === "finish-team") {
    await api(`/api/teams/${team.id}/finish`, {
      method: "POST",
      body: { finishedBy: staffName }
    });
    toast(`${team.name} 已登记完赛`);
    return;
  }

  if (action === "unfinish-team") {
    const ok = window.confirm(`撤回 ${team.name} 的完赛记录吗？`);
    if (!ok) return;
    await api(`/api/teams/${team.id}/unfinish`, { method: "POST" });
    toast("完赛记录已撤回");
    return;
  }

  if (action === "edit-team") {
    await editTeam(team);
  }
}

async function addScore(teamId, points) {
  await api(`/api/teams/${teamId}/scores`, {
    method: "POST",
    body: {
      points,
      route: scoreRoute,
      operator: staffName
    }
  });
  toast("分数已更新");
}

async function editTeam(team) {
  const name = window.prompt("队伍名称", team.name);
  if (name === null) return;
  const order = window.prompt("序号", team.order ?? "");
  if (order === null) return;

  await api(`/api/teams/${team.id}`, {
    method: "PATCH",
    body: { name, order }
  });
  toast("队伍信息已更新");
}

function renderScoreRankList() {
  const list = document.querySelector("#scoreRankList");
  list.innerHTML = "";
  const rankedTeams = currentState.ranked.filter((team) => !scoreRoute || team.route === scoreRoute);

  if (!rankedTeams.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = `暂无${scoreRoute || ""}路线排名`;
    list.appendChild(empty);
    return;
  }

  rankedTeams.forEach((team) => {
    const row = document.createElement("div");
    row.className = "mini-rank-row";
    row.style.setProperty("--team-color", team.color);
    row.innerHTML = `
      <span class="rank-badge">${getDisplayRank(team)}</span>
      <strong>${escapeHtml(team.name)}</strong>
      <span>${formatScore(team.totalScore)}</span>
    `;
    list.appendChild(row);
  });
}

function renderRankPage() {
  const leadScore = currentState.totals.leadScore;
  const leadTeams = currentState.ranked
    .filter((team) => team.totalScore === leadScore)
    .map((team) => team.name)
    .join("、") || "--";
  const activeTeams = currentState.totals.teams - currentState.totals.completedTeams;

  renderSummary("#rankSummary", [
    ["最高分", leadScore],
    ["最高分队伍", leadTeams],
    ["已完赛", currentState.totals.completedTeams],
    ["正在比赛", activeTeams]
  ]);
  renderPodium();
  renderScoreboardGrid();

  const lastUpdated = document.querySelector("#lastUpdated");
  if (lastUpdated) lastUpdated.textContent = `更新 ${formatTime(currentState.updatedAt)}`;

  const screenTeamCount = document.querySelector("#screenTeamCount");
  if (screenTeamCount) screenTeamCount.textContent = `${currentState.totals.teams} 支队伍`;
}

function renderPodium() {
  const podium = document.querySelector("#podium");
  podium.innerHTML = "";
  const topTeams = currentState.ranked.slice(0, 3);

  if (!topTeams.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state screen-empty";
    empty.textContent = "暂无队伍";
    podium.appendChild(empty);
    return;
  }

  topTeams.forEach((team) => {
    const item = document.createElement("article");
    item.className = `podium-card rank-${team.rank}`;
    item.style.setProperty("--team-color", team.color);
    item.innerHTML = `
      <span class="rank-badge large">${team.rank}</span>
      <div>
        <h2>${escapeHtml(team.name)}</h2>
        <p>${routeLabel(team.route)} · ${finishStatusText(team)} · 1分题 ${questionCount(team, 1)} · 2分题 ${questionCount(team, 2)} · 3分题 ${questionCount(team, 3)}</p>
      </div>
      <strong>${formatScore(team.totalScore)}</strong>
    `;
    podium.appendChild(item);
  });
}

function renderScoreboardGrid() {
  const grid = document.querySelector("#scoreboardGrid");
  grid.innerHTML = "";

  if (!currentState.ranked.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state screen-empty";
    empty.textContent = "暂无队伍";
    grid.appendChild(empty);
    return;
  }

  currentState.ranked.forEach((team) => {
    const card = document.createElement("article");
    card.className = "screen-team-card";
    card.style.setProperty("--team-color", team.color);

    card.innerHTML = `
      <div class="screen-rank">
        <span class="rank-badge">${team.rank}</span>
      </div>
      <div class="screen-team-main">
        <h3>${escapeHtml(team.name)}</h3>
        <div class="screen-team-meta">
          <span>${routeLabel(team.route)}</span>
          <span>序号 ${team.order ?? "--"}</span>
          <span>记录 ${team.scoreCount}</span>
          <span>加分 ${team.positiveCount}</span>
        </div>
        <div class="screen-question-counts">
          ${screenQuestionStats(team)}
        </div>
        <div class="screen-finish-line">
          <span>完赛顺序</span>
          <strong>${finishStatusText(team)}</strong>
        </div>
      </div>
      <strong class="screen-score">${formatScore(team.totalScore)}</strong>
    `;
    grid.appendChild(card);
  });
}

function screenQuestionStats(team) {
  return [1, 2, 3]
    .map(
      (points) => `
        <div class="screen-question-item">
          <span>${points}分题</span>
          <strong>${questionCount(team, points)}</strong>
        </div>
      `
    )
    .join("");
}

function finishStatusText(team) {
  return team.completed ? `第 ${team.finishOrder} 名 · +${formatScore(team.finishScore)}` : "未完赛";
}

function routeLabel(route) {
  return route ? `${route}路线` : "未分路线";
}

function renderSummary(selector, items) {
  const summary = document.querySelector(selector);
  if (!summary) return;
  summary.innerHTML = "";
  items.forEach(([label, value]) => summary.appendChild(summaryItem(label, value)));
}

function summaryItem(label, value) {
  const item = document.createElement("div");
  item.className = "summary-item";
  item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(formatSummaryValue(value))}</strong>`;
  return item;
}

function formatSummaryValue(value) {
  const number = Number(value);
  if (Number.isFinite(number) && String(value).trim() !== "") return formatScore(number);
  return String(value ?? "--");
}

function compareTeamDisplay(a, b) {
  const orderA = a.order ?? Number.POSITIVE_INFINITY;
  const orderB = b.order ?? Number.POSITIVE_INFINITY;
  if (orderA !== orderB) return orderA - orderB;
  return a.name.localeCompare(b.name, "zh-CN");
}

function compareEventTimeDesc(a, b) {
  return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "");
}

function setConnection(connected) {
  const status = document.querySelector("#connectionStatus");
  if (!status) return;
  status.textContent = connected ? "已连接" : "重连中";
  status.classList.toggle("is-online", connected);
}

function toast(message) {
  const box = document.querySelector("#toast");
  if (!box) return;
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(box.timer);
  box.timer = setTimeout(() => box.classList.remove("show"), 2200);
}

function formatScore(value) {
  const number = Number(value || 0);
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(1).replace(/\.0$/, "");
}

function formatSignedScore(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : ""}${formatScore(number)}`;
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
