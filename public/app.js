const page = document.body.dataset.page;
const scoreRoute = document.body.dataset.scoreRoute || "";
let currentState = null;
let eventsConnection = null;
let pollTimer = null;
let renderFrame = null;

const scoreOptionsByRoute = {
  A: [
    { buttonLabel: "得 1 分", statLabel: "1分题", points: 1 },
    { buttonLabel: "得 2 分", statLabel: "2分题", points: 2 },
    { buttonLabel: "0 分（不得分）", statLabel: "不得分", points: 0 }
  ],
  B: [
    { buttonLabel: "得 2 分", statLabel: "2分题", points: 2 },
    { buttonLabel: "得 3 分", statLabel: "3分题", points: 3 },
    { buttonLabel: "0 分（不得分）", statLabel: "不得分", points: 0 }
  ]
};

document.addEventListener("DOMContentLoaded", () => {
  if (page === "score") initScorePage();
  connectEvents();
  fetchState();
});

function initScorePage() {
  document.querySelector("#teamsList").addEventListener("click", onTeamsListClick);
}

function connectEvents() {
  closeEvents();

  if (!window.EventSource) {
    startPolling();
    return;
  }

  eventsConnection = new EventSource(scoreApiUrl("/api/events"));
  eventsConnection.addEventListener("open", () => setConnection(true));
  eventsConnection.addEventListener("error", () => {
    setConnection(false);
    if (eventsConnection) {
      eventsConnection.close();
      eventsConnection = null;
    }
    startPolling();
  });
  eventsConnection.addEventListener("state", (event) => {
    currentState = JSON.parse(event.data);
    setConnection(true);
    scheduleRender();
  });
}

function startPolling() {
  if (pollTimer) return;
  setConnection(false);
  fetchState();
  pollTimer = setInterval(fetchState, 3000);
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
    const response = await fetch(scoreApiUrl("/api/state"), { cache: "no-store" });
    if (response.status === 401 && page === "score") return redirectToScoreLogin();
    if (!response.ok) throw new Error("State request failed");
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
  if (response.status === 401 && page === "score") {
    redirectToScoreLogin();
    throw new Error("Authentication required");
  }
  if (!response.ok) {
    toast(data.error || "操作失败");
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function scoreApiUrl(pathname) {
  if (page !== "score") return pathname;
  const separator = pathname.includes("?") ? "&" : "?";
  if (pathname === "/api/state") return `/api/score-state?route=${encodeURIComponent(scoreRoute)}`;
  if (pathname === "/api/events") return `/api/events?route=${encodeURIComponent(scoreRoute)}`;
  return `${pathname}${separator}route=${encodeURIComponent(scoreRoute)}`;
}

function redirectToScoreLogin() {
  closeEvents();
  window.location.replace(`/score-login.html?route=${encodeURIComponent(scoreRoute)}`);
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
          ${teamOrderBadge(team)}
          <h3>${escapeHtml(team.name)}</h3>
        </div>
        <div class="team-meta">
          <span>序号 ${team.order ?? "--"}</span>
          <span>${team.source === "quiz" ? "题库同步" : "手动添加"}</span>
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
        ${team.source === "quiz"
          ? '<button type="button" class="ghost-btn" data-action="edit-team">编辑序号</button>'
          : '<button type="button" class="ghost-btn" data-action="edit-team">编辑</button><button type="button" class="danger-ghost-btn" data-action="delete-team">删除</button>'}
      </div>
    </div>

    <div class="question-counts" aria-label="答题得分统计">
      ${scoreOptions(team.route)
        .map(
          (item) => `
            <div class="question-count-item">
              <span>${item.statLabel}</span>
              <strong>${questionCount(team, item.points)}</strong>
            </div>
          `
        )
        .join("")}
    </div>

    <div class="score-entry-panel">
      <div class="quick-score-row">
        ${scoreOptions(scoreRoute)
          .map(
            (item) => `
              <button type="button" class="${item.points === 0 ? "quick-zero" : "quick-plus"}"
                data-action="quick-score" data-points="${item.points}">
                ${item.buttonLabel}
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
  const isZero = Number(event.points) === 0;

  return `
    <div class="score-event ${isZero ? "is-zero" : "is-plus"}">
      <div>
        ${route}
        <span>${formatTime(event.createdAt)}</span>
        ${operator}
      </div>
      <b>${isZero ? "0（不得分）" : formatSignedScore(event.points)}</b>
      <button type="button" class="ghost-btn icon-btn" title="撤销" data-action="delete-score" data-score-id="${event.id}">×</button>
    </div>
  `;
}

function questionCount(team, points) {
  return Number((team.questionCounts || {})[points] || 0);
}

function scoreOptions(route) {
  return scoreOptionsByRoute[String(route || "").toUpperCase()] || [];
}

function teamOrderBadge(team) {
  const order = team.order ?? "--";
  const label = team.order ?? "未设置";
  return `<span class="rank-badge team-order-badge" title="队伍序号" aria-label="队伍序号 ${escapeHtml(label)}">${escapeHtml(order)}</span>`;
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
    await api(`/api/teams/${team.id}/finish`, { method: "POST" });
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
      route: scoreRoute
    }
  });
  toast("分数已更新");
}

async function editTeam(team) {
  if (team.source === "quiz") {
    const order = window.prompt("队伍序号（留空表示不设置）", team.order ?? "");
    if (order === null) return;
    await api(`/api/teams/${team.id}`, {
      method: "PATCH",
      body: { order }
    });
    toast("队伍序号已更新");
    return;
  }

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

function renderRankPage() {
  const routeATeams = currentState.teams.filter((team) => team.route === "A");
  const routeBTeams = currentState.teams.filter((team) => team.route === "B");
  const routeALead = routeATeams.length ? Math.max(...routeATeams.map((team) => team.totalScore)) : 0;
  const routeBLead = routeBTeams.length ? Math.max(...routeBTeams.map((team) => team.totalScore)) : 0;

  renderSummary("#rankSummary", [
    ["A路线队伍", routeATeams.length],
    ["A路线最高分", routeALead],
    ["B路线队伍", routeBTeams.length],
    ["B路线最高分", routeBLead]
  ]);
  renderOverallRanking(currentState.teams);
  renderRouteScoreboard("A", routeATeams);
  renderRouteScoreboard("B", routeBTeams);

  const lastUpdated = document.querySelector("#lastUpdated");
  if (lastUpdated) lastUpdated.textContent = `更新 ${formatTime(currentState.updatedAt)}`;

}

function renderOverallRanking(teams) {
  const grid = document.querySelector("#overallRankingGrid");
  const count = document.querySelector("#overallCount");
  grid.innerHTML = "";
  count.textContent = `${teams.length} 支队伍`;

  if (!teams.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state screen-empty";
    empty.textContent = "暂无参赛队伍";
    grid.appendChild(empty);
    return;
  }

  teams
    .slice()
    .sort((a, b) => (a.rank || Number.POSITIVE_INFINITY) - (b.rank || Number.POSITIVE_INFINITY))
    .forEach((team) => grid.appendChild(rankListItem(team, team.rank)));
}

function renderRouteScoreboard(route, teams) {
  const grid = document.querySelector(`#route${route}Grid`);
  const count = document.querySelector(`#route${route}Count`);
  grid.innerHTML = "";
  count.textContent = `${teams.length} 支队伍`;

  if (!teams.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state screen-empty";
    empty.textContent = `暂无${route}路线队伍`;
    grid.appendChild(empty);
    return;
  }

  teams
    .slice()
    .sort((a, b) => (a.routeRank || Number.POSITIVE_INFINITY) - (b.routeRank || Number.POSITIVE_INFINITY))
    .forEach((team) => grid.appendChild(rankListItem(team, team.routeRank)));
}

function rankListItem(team, rank) {
  const item = document.createElement("article");
  item.className = "rank-list-item";
  item.style.setProperty("--team-color", team.color);
  item.innerHTML = `
    <div class="ranking-leading">
      <span class="rank-position">第 ${rank || "--"} 名</span>
      ${teamOrderBadge(team)}
    </div>
    <div class="rank-list-team">
      <strong>${escapeHtml(team.name)}</strong>
      <span class="rank-list-route route-${String(team.route || "").toLowerCase()}">${escapeHtml(routeLabel(team.route))}</span>
    </div>
    <strong class="rank-list-score">${formatScore(team.totalScore)}</strong>
  `;
  return item;
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
