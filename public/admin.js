const $ = (selector) => document.querySelector(selector);
let selectedFile = null;
let toastTimer;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  try {
    await loadDashboard();
  } catch {
    showLogin();
  }
}

function bindEvents() {
  $("#adminLoginForm").addEventListener("submit", login);
  $("#adminLogoutBtn").addEventListener("click", logout);
  $("#quizFile").addEventListener("change", (event) => selectFile(event.target.files[0]));
  $("#uploadForm").addEventListener("submit", upload);
  $("#teamImportForm").addEventListener("submit", importTeams);
  $("#teamList").addEventListener("click", manageTeam);
  $("#userList").addEventListener("click", manageUser);
  const zone = $("#dropZone");
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove("dragging"); }));
  zone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (file) selectFile(file);
  });
}

async function login(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const button = formElement.querySelector("button");
  setBusy(button, true, "验证中…");
  try {
    const password = new FormData(formElement).get("password");
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
    formElement.reset();
    await loadDashboard();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

async function logout() {
  await api("/api/admin/logout", { method: "POST" }).catch(() => null);
  showLogin();
}

function showLogin() {
  $("#adminLoginView").classList.remove("hidden");
  $("#adminDashboard").classList.add("hidden");
}

async function loadDashboard() {
  const data = await api("/api/admin/status");
  $("#adminLoginView").classList.add("hidden");
  $("#adminDashboard").classList.remove("hidden");
  renderStats(data.stats);
  renderTeams(data.teams || []);
  renderUsers(data.users || []);
}

function renderStats(stats) {
  const tierMap = Object.fromEntries(stats.tiers.map((item) => [item.tier, item.total]));
  $("#adminStats").innerHTML = `
    <article><span>题目总数</span><strong>${stats.questions}</strong><small>道共享题目</small></article>
    <article><span>1档 / 2档 / 3档</span><strong>${tierMap[1] || 0}<i>/</i>${tierMap[2] || 0}<i>/</i>${tierMap[3] || 0}</strong><small>分档数量</small></article>
    <article><span>预设队伍</span><strong>${stats.availableTeams}<i>/</i>${stats.teams}</strong><small>可引用 / 全部</small></article>
    <article><span>参赛账号</span><strong>${stats.users}</strong><small>支队伍</small></article>
    <article><span>累计作答</span><strong>${stats.attempts}</strong><small>次独立记录</small></article>`;
}

function renderTeams(teams) {
  const available = teams.filter((team) => !team.claimed).length;
  $("#teamCountLabel").textContent = `${teams.length} 个队伍 · ${available} 个可引用`;
  if (!teams.length) {
    $("#teamList").innerHTML = `<p class="admin-empty">尚未录入队伍信息。</p>`;
    return;
  }
  $("#teamList").innerHTML = teams.map((team) => `<article class="team-row">
    <div><strong>${escapeHtml(team.name)}</strong><small>${team.claimed ? `已由 @${escapeHtml(team.claimedBy.username)} 引用` : "等待选手引用"}</small></div>
    <span class="team-status ${team.claimed ? "is-claimed" : "is-available"}">${team.claimed ? "已引用" : "可引用"}</span>
    <button class="user-action delete-user" type="button" data-team-id="${escapeHtml(team.id)}" data-team-name="${escapeHtml(team.name)}" ${team.claimed ? "disabled" : ""}>${team.claimed ? "不可删除" : "删除"}</button>
  </article>`).join("");
}

async function importTeams(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#teamImportButton");
  const names = new FormData(form).get("names");
  setBusy(button, true, "导入中…");
  try {
    const result = await api("/api/admin/teams/import", { method: "POST", body: JSON.stringify({ names }) });
    form.reset();
    toast(`${result.message}${result.skipped ? `，跳过${result.skipped}个重复名称` : ""}`);
    await loadDashboard();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

async function manageTeam(event) {
  const button = event.target.closest("button[data-team-id]");
  if (!button || button.disabled) return;
  const { teamId, teamName } = button.dataset;
  if (!window.confirm(`确定删除预设队伍“${teamName}”吗？`)) return;
  setBusy(button, true, "删除中…");
  try {
    const result = await api(`/api/admin/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
    toast(result.message);
    await loadDashboard();
  } catch (error) {
    toast(error.message);
    setBusy(button, false);
  }
}

function renderUsers(users) {
  $("#userCountLabel").textContent = `${users.length} 个用户`;
  if (!users.length) {
    $("#userList").innerHTML = `<p class="admin-empty">暂无注册用户。</p>`;
    return;
  }
  $("#userList").innerHTML = `<div class="user-list-head" aria-hidden="true">
    <span>队伍 / 账号</span><span>注册与最近作答</span><span>答题统计</span><span>得分</span><span>操作</span>
  </div>${users.map((user) => `<article class="user-row">
    <div class="user-identity"><strong>${escapeHtml(user.teamName)}</strong><small>@${escapeHtml(user.username)} · ${escapeHtml(user.routeLabel || `${user.route || "A"}路线`)}</small></div>
    <div class="user-time"><span>注册 ${formatDateTime(user.createdAt)}</span><small>${user.lastAnsweredAt ? `最近 ${formatDateTime(user.lastAnsweredAt)}` : "尚未答题"}</small></div>
    <div class="user-results"><span>已答 <b>${user.answered}</b></span><small class="correct-text">对 ${user.correct}</small><small class="wrong-text">错 ${user.wrong}</small></div>
    <strong class="user-score">${user.score}<small>分</small></strong>
    <div class="user-actions">
      <button class="user-action reset-user" type="button" data-action="reset" data-user-id="${escapeHtml(user.id)}" data-team-name="${escapeHtml(user.teamName)}">重置答题</button>
      <button class="user-action delete-user" type="button" data-action="delete" data-user-id="${escapeHtml(user.id)}" data-team-name="${escapeHtml(user.teamName)}">删除用户</button>
    </div>
  </article>`).join("")}`;
}

async function manageUser(event) {
  const button = event.target.closest("button[data-action][data-user-id]");
  if (!button) return;
  const { action, userId, teamName } = button.dataset;
  const deleting = action === "delete";
  const confirmed = window.confirm(deleting
    ? `确定删除“${teamName}”吗？\n\n账号和全部答题记录将永久删除，且无法恢复。`
    : `确定重置“${teamName}”的答题记录吗？\n\n账号会保留，已答题目、对错和得分将清零。`);
  if (!confirmed) return;
  setBusy(button, true, deleting ? "删除中…" : "重置中…");
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(userId)}${deleting ? "" : "/reset"}`, {
      method: deleting ? "DELETE" : "POST"
    });
    toast(result.message);
    await loadDashboard();
  } catch (error) {
    toast(error.message);
    setBusy(button, false);
  }
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date).replaceAll("/", "-");
}

function selectFile(file) {
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) {
    toast("请选择 .xlsx 格式的 Excel 文件");
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast("文件不能超过8MB");
    return;
  }
  selectedFile = file;
  $("#fileName").textContent = file.name;
  $("#fileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · 已准备导入`;
  $("#dropZone").classList.add("has-file");
}

async function upload(event) {
  event.preventDefault();
  if (!selectedFile) return toast("请先选择 Excel 题库文件");
  const form = event.currentTarget;
  const button = $("#uploadButton");
  const mode = new FormData(form).get("mode");
  setBusy(button, true, "正在读取并导入…");
  try {
    const data = await toBase64(selectedFile);
    const result = await api("/api/admin/import", {
      method: "POST",
      body: JSON.stringify({ filename: selectedFile.name, data, mode })
    });
    toast(`${result.message}，当前共${result.total}题`);
    selectedFile = null;
    $("#quizFile").value = "";
    $("#fileName").textContent = "点击选择或拖入 Excel 文件";
    $("#fileMeta").textContent = "尚未选择文件";
    $("#dropZone").classList.remove("has-file");
    await loadDashboard();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("文件读取失败，请重新选择"));
    reader.readAsDataURL(file);
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) }, credentials: "same-origin", cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "操作失败，请稍后重试");
    error.status = response.status;
    throw error;
  }
  return data;
}

function setBusy(button, busy, label) {
  if (!button.dataset.defaultText) button.dataset.defaultText = button.innerHTML;
  button.disabled = busy;
  button.innerHTML = busy ? label : button.dataset.defaultText;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 4200);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

