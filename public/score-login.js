const route = String(new URLSearchParams(window.location.search).get("route") || "").toUpperCase();
const destination = route === "A" ? "/score-a.html" : route === "B" ? "/score-b.html" : "";
const title = document.querySelector("#loginTitle");
const hint = document.querySelector("#loginHint");
const form = document.querySelector("#scoreLoginForm");
const password = document.querySelector("#scorePassword");
const error = document.querySelector("#loginError");
const submit = document.querySelector("#loginSubmit");

if (!destination) {
  title.textContent = "无效的计分台入口";
  hint.textContent = "请从A路线或B路线计分台链接进入。";
  form.hidden = true;
} else {
  title.textContent = `${route}路线计分台登录`;
  hint.textContent = `请输入${route}路线计分台登录口令。`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;
  submit.textContent = "验证中…";

  try {
    const response = await fetch("/api/score-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route, password: password.value })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "登录失败");
    window.location.replace(destination);
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
    password.select();
  } finally {
    submit.disabled = false;
    submit.textContent = "进入计分台";
  }
});
