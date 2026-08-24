const state = { dashboard: null, availableTeams: [], tier: null, question: null, selected: null, answering: false };
const QUESTION_TYPES = { single: "单选", multiple: "多选", judgment: "判断", image_correction: "看图纠错" };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  try {
    const auth = await api("/api/auth/me");
    if (auth.authenticated) await showDashboard();
    else showAuth();
  } catch (error) {
    showAuth();
    toast(error.message);
  }
}

function bindEvents() {
  $$('[data-auth-tab]').forEach((button) => button.addEventListener("click", () => switchAuth(button.dataset.authTab)));
  $("#loginForm").addEventListener("submit", login);
  $("#registerForm").addEventListener("submit", register);
  $("#teamSelect").addEventListener("change", updateTeamAvailability);
  $("#logoutBtn").addEventListener("click", logout);
  $("#tierGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tier]");
    if (button && !button.disabled) openTier(Number(button.dataset.tier));
  });
  $$('[data-close-question]').forEach((item) => item.addEventListener("click", closeQuestion));
  $("#answerForm").addEventListener("change", onAnswerSelect);
  $("#answerForm").addEventListener("submit", submitAnswer);
  $("#nextQuestionBtn").addEventListener("click", loadNextQuestion);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#questionLayer").classList.contains("hidden")) closeQuestion();
  });
}

function switchAuth(tab) {
  $$('[data-auth-tab]').forEach((button) => {
    const active = button.dataset.authTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#loginForm").classList.toggle("hidden", tab !== "login");
  $("#registerForm").classList.toggle("hidden", tab !== "register");
  if (tab === "register") loadAvailableTeams().catch((error) => toast(error.message));
}

async function loadAvailableTeams() {
  const select = $("#teamSelect");
  const submit = $("#registerForm button[type=submit]");
  select.disabled = true;
  select.innerHTML = `<option value="">正在加载队伍信息…</option>`;
  const data = await api("/api/teams/available");
  state.availableTeams = data.teams || [];
  select.innerHTML = `<option value="">请选择自己的队伍</option>${state.availableTeams.map((team) => `<option value="${escapeHtml(team.id)}">${escapeHtml(team.name)}</option>`).join("")}`;
  select.disabled = state.availableTeams.length === 0;
  submit.disabled = state.availableTeams.length === 0;
  updateTeamAvailability();
}

function updateTeamAvailability() {
  const select = $("#teamSelect");
  const helper = $("#teamAvailability");
  if (!state.availableTeams.length) {
    helper.textContent = "当前没有可引用的队伍，请联系管理员提前录入。";
    return;
  }
  helper.textContent = select.value
    ? "已选中该队伍，注册成功后将立即锁定，其他人无法再引用。"
    : `当前有 ${state.availableTeams.length} 个可引用队伍，请选择自己的队伍。`;
}

async function login(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const button = formElement.querySelector("button[type=submit]");
  setBusy(button, true, "登录中…");
  try {
    const form = new FormData(formElement);
    await api("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    formElement.reset();
    await showDashboard();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}

async function register(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const button = formElement.querySelector("button[type=submit]");
  setBusy(button, true, "注册中…");
  try {
    const form = new FormData(formElement);
    await api("/api/auth/register", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    formElement.reset();
    await showDashboard();
    toast("注册成功，欢迎参赛！");
  } catch (error) {
    toast(error.message);
    if (error.status === 409) await loadAvailableTeams().catch(() => null);
  } finally {
    setBusy(button, false);
    if (!state.availableTeams.length) button.disabled = true;
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => null);
  state.dashboard = null;
  closeQuestion();
  showAuth();
}

function showAuth() {
  $("#authView").classList.remove("hidden");
  $("#dashboardView").classList.add("hidden");
  $("#headerUser").classList.add("hidden");
}

async function showDashboard() {
  await refreshDashboard();
  $("#authView").classList.add("hidden");
  $("#dashboardView").classList.remove("hidden");
  $("#headerUser").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refreshDashboard() {
  state.dashboard = await api("/api/quiz/dashboard");
  renderDashboard();
}

function renderDashboard() {
  const data = state.dashboard;
  $("#welcomeTeam").textContent = data.user.teamName;
  $("#teamPill").textContent = `${data.user.teamName} · ${data.user.routeLabel}`;
  $("#routeHint").textContent = `${data.user.routeLabel}：可使用${data.user.route === "B" ? "2档和3档" : "1档和2档"}答题包，每道题只有一次回答机会。`;
  $("#heroScore").textContent = data.summary.score;
  $("#statAnswered").textContent = data.summary.answered;
  $("#statCorrect").textContent = data.summary.correct;
  $("#statWrong").textContent = data.summary.wrong;
  $("#statScore").textContent = data.summary.score;
  renderTiers(data.tiers);
  renderHistory(data.history);
}

function renderTiers(tiers) {
  const names = { 1: ["基础热身", "稳稳拿分，从基础知识开始"], 2: ["进阶挑战", "需要一点思考的专业题"], 3: ["高手冲刺", "冲击高分的终极挑战"] };
  const tierGrid = $("#tierGrid");
  tierGrid.classList.toggle("route-two-tiers", tiers.length === 2);
  tierGrid.innerHTML = tiers.map((tier) => {
    const progress = tier.total ? Math.round((tier.answered / tier.total) * 100) : 0;
    const complete = tier.total > 0 && tier.remaining === 0;
    return `<article class="tier-card tier-${tier.tier}">
      <div class="tier-card-top"><span class="tier-number">0${tier.tier}</span><span class="point-chip">答对 +${tier.points} 分</span></div>
      <div class="tier-card-copy"><h3>${names[tier.tier][0]}</h3><p>${names[tier.tier][1]}</p></div>
      <div class="tier-progress"><div><span>完成进度</span><b>${tier.answered} / ${tier.total}</b></div><div class="progress-track"><i style="width:${progress}%"></i></div></div>
      <button class="tier-button" type="button" data-tier="${tier.tier}" ${tier.remaining === 0 ? "disabled" : ""}>
        ${tier.total === 0 ? "暂无题目" : complete ? "已全部完成" : tier.answered ? "继续答题" : "开始答题"}<span aria-hidden="true">→</span>
      </button>
    </article>`;
  }).join("");
}

function renderHistory(history) {
  $("#historyCount").textContent = `共${history.length}题`;
  if (!history.length) {
    $("#historyList").innerHTML = `<div class="empty-history"><span>答</span><p>还没有答题记录<br /><small>选择上方任意答题包开始挑战吧</small></p></div>`;
    return;
  }
  $("#historyList").innerHTML = history.map((item, index) => `<article class="history-row">
    <span class="history-index">${String(history.length - index).padStart(2, "0")}</span>
    <div class="history-question"><strong>${escapeHtml(item.prompt)}</strong><small>${QUESTION_TYPES[item.type] || "单选"} · ${item.tier}档 · 选择 ${formatAnswerKeys(item.selectedAnswer)} · ${formatTime(item.answeredAt)}</small></div>
    <span class="result-badge ${item.correct ? "is-correct" : "is-wrong"}">${item.correct ? "答对" : "答错"}</span>
    <b class="history-points ${item.correct ? "has-points" : ""}">${item.correct ? `+${item.points}` : "0"}<small>分</small></b>
  </article>`).join("");
}

async function openTier(tier) {
  state.tier = tier;
  $("#questionLayer").classList.remove("hidden");
  document.body.classList.add("modal-open");
  await loadNextQuestion();
}

function closeQuestion() {
  $("#questionLayer").classList.add("hidden");
  document.body.classList.remove("modal-open");
  state.question = null;
}

async function loadNextQuestion() {
  resetQuestionView();
  try {
    const data = await api(`/api/quiz/next?tier=${state.tier}`);
    if (!data.question) {
      closeQuestion();
      await refreshDashboard();
      toast(data.message || "这一档题目已经全部答完");
      return;
    }
    state.question = data.question;
    const typeLabel = QUESTION_TYPES[data.question.type] || "单选";
    const multiAnswer = data.question.type === "multiple" || data.question.type === "image_correction";
    $("#questionTier").textContent = `${typeLabel} · ${data.question.tier}档 · 答对 +${data.question.tier}分`;
    $("#questionProgress").textContent = `本档剩余 ${data.remaining} 题`;
    $("#questionTitle").textContent = data.question.prompt;
    $("#answerHint").textContent = multiAnswer ? "可选择多个答案，选全且无错选才得分" : data.question.type === "judgment" ? "请选择“正确”或“错误”" : "请选择一个答案";
    renderQuestionImage(data.question);
    $("#answerOptions").innerHTML = data.question.options.map((option) => `<label class="answer-option">
      <input type="${multiAnswer ? "checkbox" : "radio"}" name="answer" value="${option.key}" />
      <span class="option-letter">${option.key}</span><span class="option-text">${escapeHtml(option.text)}</span><span class="option-check" aria-hidden="true">✓</span>
    </label>`).join("");
  } catch (error) {
    if (error.status === 401) { showAuth(); closeQuestion(); }
    toast(error.message);
  }
}

function resetQuestionView() {
  state.selected = null;
  state.answering = false;
  $("#answerForm").classList.remove("hidden");
  $("#answerResult").classList.add("hidden");
  $("#questionTitle").textContent = "题目加载中…";
  $("#answerHint").textContent = "";
  $("#questionMedia").classList.add("hidden");
  $("#questionImageError").classList.add("hidden");
  $("#questionImage").removeAttribute("src");
  $("#answerOptions").innerHTML = `<div class="question-loading"><i></i><i></i><i></i></div>`;
  $("#submitAnswer").disabled = true;
}

function onAnswerSelect(event) {
  if (!event.target.matches('input[name="answer"]')) return;
  state.selected = $$('input[name="answer"]:checked').map((input) => input.value).sort().join(",");
  $("#submitAnswer").disabled = !state.selected;
}

function renderQuestionImage(question) {
  const media = $("#questionMedia");
  const image = $("#questionImage");
  const error = $("#questionImageError");
  if (!question.imageUrl) {
    media.classList.add("hidden");
    return;
  }
  media.classList.remove("hidden");
  error.classList.add("hidden");
  image.classList.remove("hidden");
  image.alt = `${QUESTION_TYPES[question.type] || "题目"}配图`;
  image.onerror = () => {
    image.classList.add("hidden");
    error.classList.remove("hidden");
  };
  image.src = question.imageUrl;
}

async function submitAnswer(event) {
  event.preventDefault();
  if (!state.question || !state.selected || state.answering) return;
  state.answering = true;
  const button = $("#submitAnswer");
  setBusy(button, true, "提交中…");
  try {
    const result = await api("/api/quiz/answer", {
      method: "POST",
      body: JSON.stringify({ questionId: state.question.id, answer: state.selected })
    });
    state.dashboard = result.dashboard;
    renderDashboard();
    showResult(result);
  } catch (error) {
    toast(error.message);
    state.answering = false;
    setBusy(button, false);
  }
}

function showResult(result) {
  $("#answerForm").classList.add("hidden");
  $("#answerResult").classList.remove("hidden");
  $("#answerResult").classList.toggle("correct-result", result.correct);
  $("#answerResult").classList.toggle("wrong-result", !result.correct);
  $("#resultTitle").innerHTML = result.correct ? `<span>✓</span><strong>回答正确</strong><b>+${result.points}分</b>` : `<span>×</span><strong>回答错误</strong><b>+0分</b>`;
  const selectedText = formatCurrentAnswer(result.selectedAnswer);
  const correctText = formatCurrentAnswer(result.correctAnswer);
  $("#resultAnswer").textContent = result.correct ? `你选择了 ${selectedText}，继续保持！` : `你选择了 ${selectedText}，正确答案是 ${correctText}`;
  $("#resultExplanation").textContent = result.explanation;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    cache: "no-store"
  });
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

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "刚刚" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function formatAnswerKeys(value) {
  return String(value || "").split(",").filter(Boolean).join("、") || "—";
}

function formatCurrentAnswer(value) {
  const optionMap = Object.fromEntries((state.question?.options || []).map((option) => [option.key, option.text]));
  return String(value || "").split(",").filter(Boolean).map((key) => `${key}.${optionMap[key] || key}`).join("、") || "—";
}
