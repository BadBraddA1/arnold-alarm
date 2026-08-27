const TZ = "America/Chicago";
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

let state = {
  session: null,
  config: null,
  route: "pin",
  gatewayStatus: "checking",
  message: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function setRoute(route) {
  state.route = route;
  state.message = null;
  render();
}

function banner() {
  if (!state.message) return "";
  const cls = state.message.kind === "ok" ? "success-banner" : "error-banner";
  return `<div class="${cls}">${escapeHtml(state.message.text)}</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function canRemotePlay() {
  return !!state.session?.scopes?.includes("remote");
}

function statusCopy() {
  if (canRemotePlay()) {
    return ["ok", "Ready — plays through campus (works off Wi‑Fi)"];
  }
  if (state.gatewayStatus === "online") {
    return ["ok", "Ready — on church network"];
  }
  if (state.gatewayStatus === "checking") {
    return ["warn", "Checking campus connection…"];
  }
  return ["bad", "Not on church Wi‑Fi — play unavailable"];
}

function playHint() {
  if (canRemotePlay()) {
    return "Commands go to campus automatically — no church Wi‑Fi needed.";
  }
  return "You must be on church Wi‑Fi to play.";
}

function header(label) {
  const [dot, text] = statusCopy();
  return `
    <header class="app-header">
      <div>
        <div class="brand">Arnold <span>Alarm</span></div>
        ${label ? `<div class="muted">${escapeHtml(label)}</div>` : ""}
        <div class="status-row" style="margin-top:0.4rem">
          <span class="dot ${dot}"></span><span>${text}</span>
        </div>
      </div>
      <button type="button" class="btn btn-ghost" data-action="logout">Sign out</button>
    </header>`;
}

function renderPin() {
  app.innerHTML = `
    <main class="app-shell" style="justify-content:center">
      <div class="card stack" style="gap:1.25rem">
        <div>
          <p class="muted" style="margin:0 0 0.35rem;text-transform:uppercase;letter-spacing:0.08em;font-size:0.75rem">Arnold Church of Christ</p>
          <h1 class="page-title">Alarm</h1>
          <p class="muted" style="margin:0">Enter your 6-digit PIN to continue.</p>
        </div>
        <div class="pin-inputs" id="pin-inputs">
          ${[0, 1, 2, 3, 4, 5].map((i) => `<input inputmode="numeric" maxlength="1" data-i="${i}" aria-label="Digit ${i + 1}" />`).join("")}
        </div>
        <div id="pin-msg"></div>
      </div>
    </main>`;
  wirePin();
}

function wirePin() {
  const inputs = [...document.querySelectorAll("#pin-inputs input")];
  const msg = $("#pin-msg");
  inputs[0]?.focus();

  function read() {
    return inputs.map((i) => i.value).join("");
  }

  async function submit(pin) {
    msg.innerHTML = `<p class="muted">Checking PIN…</p>`;
    const { res, data } = await api("/api/auth/pin", {
      method: "POST",
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not sign in.")}</div>`;
      inputs.forEach((i) => (i.value = ""));
      inputs[0].focus();
      return;
    }
    state.session = { label: data.label, scopes: data.scopes };
    setRoute("home");
  }

  inputs.forEach((input, i) => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(-1);
      if (input.value && i < 5) inputs[i + 1].focus();
      const pin = read();
      if (pin.length === 6) void submit(pin);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !input.value && i > 0) inputs[i - 1].focus();
    });
  });

  $("#pin-inputs").addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    text.split("").forEach((ch, i) => {
      if (inputs[i]) inputs[i].value = ch;
    });
    if (text.length === 6) void submit(text);
    else inputs[text.length]?.focus();
  });
}

function renderHome() {
  const s = state.session;
  const canBells = s.scopes.includes("bells") || s.scopes.includes("admin");
  const canEvac = s.scopes.includes("evacuate") || s.scopes.includes("admin");
  const canAdmin = s.scopes.includes("admin");
  app.innerHTML = `
    <main class="app-shell">
      ${header(s.label)}
      <div class="stack">
        <div>
          <h1 class="page-title">Choose a panel</h1>
          <p class="muted" style="margin:0">Access is limited to what your PIN allows.</p>
        </div>
        <div class="tile-grid">
          ${canBells ? `<button type="button" class="tile" data-go="bells"><h2>Class bells</h2><p>Play period and chapel tones on campus speakers.</p></button>` : ""}
          ${canEvac ? `<button type="button" class="tile" data-go="evacuate"><h2>Emergency codes</h2><p>Code Red, Blue, and Green announcements.</p></button>` : ""}
          ${canAdmin ? `<button type="button" class="tile" data-go="admin"><h2>PIN admin</h2><p>Add or revoke staff PINs.</p></button>` : ""}
        </div>
        <div class="card stack">
          <p style="margin:0;font-weight:600">Recent activity</p>
          <p class="muted" style="margin:0;font-size:0.85rem">Who activated what, and when (Central).</p>
          <div id="audit-list" class="muted">Loading…</div>
        </div>
        ${banner()}
      </div>
    </main>`;
  void loadAudit();
}

async function loadAudit() {
  const el = $("#audit-list");
  if (!el) return;
  const { res, data } = await api("/api/audit");
  if (!res.ok) {
    el.textContent = "Could not load activity.";
    return;
  }
  const events = data.events || [];
  if (!events.length) {
    el.textContent = "No activations yet.";
    return;
  }
  el.className = "audit-list";
  el.innerHTML = events
    .slice(0, 40)
    .map((e) => {
      const ok = e.status === "done" || e.status === "queued" || e.status === "scheduled";
      const detail = [e.mode, e.detail].filter(Boolean).join(" · ");
      return `<div class="audit-item">
        <div class="when">${escapeHtml(formatCentral(e.createdAt))}</div>
        <p class="who-action">${escapeHtml(e.label)} · ${escapeHtml(actionLabel(e.actionId))}</p>
        ${detail ? `<div class="meta">${escapeHtml(detail)}</div>` : ""}
        <span class="status-pill ${ok ? "ok" : "bad"}">${escapeHtml(e.status)}</span>
      </div>`;
    })
    .join("");
}

function clockHtml() {
  return `
    <div class="card clock-card">
      <p class="muted" style="margin:0 0 0.35rem;text-transform:uppercase;letter-spacing:0.1em;font-size:0.72rem">Building time</p>
      <div class="clock-time" id="clock-time">—</div>
      <p class="muted" id="clock-date" style="margin:0.45rem 0 0;font-size:0.95rem"></p>
    </div>`;
}

function tickClock() {
  const now = new Date();
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(now);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(now);
  const t = $("#clock-time");
  const d = $("#clock-date");
  if (t) t.textContent = time;
  if (d) d.textContent = `${date} · Central`;
}

async function logAudit(actionId, mode, status, detail) {
  try {
    await api("/api/audit", {
      method: "POST",
      body: JSON.stringify({ actionId, mode, status, detail }),
    });
  } catch {
    /* ignore */
  }
}

function actionLabel(actionId) {
  const bells = state.config?.bellActions || [];
  const evacs = state.config?.evacuateActions || [];
  const hit = [...bells, ...evacs].find((a) => a.id === actionId);
  return hit?.label || actionId;
}

function formatCentral(iso) {
  try {
    const d = new Date(iso.includes("T") || iso.includes("Z") ? iso : iso + "Z");
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(d);
  } catch {
    return iso;
  }
}

async function playAction(actionId, msgEl, delayMinutes = 0, loop = false) {
  msgEl.innerHTML = "";
  const canRemote = canRemotePlay();

  if (canRemote) {
    const { res, data } = await api("/api/play-remote", {
      method: "POST",
      body: JSON.stringify({ actionId, delayMinutes, loop }),
    });
    if (!res.ok) {
      msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Remote play failed.")}</div>`;
      return;
    }
    await logAudit(actionId, "remote", delayMinutes > 0 ? "scheduled" : "queued", loop ? "loop" : undefined);
    msgEl.innerHTML = `<div class="success-banner">${escapeHtml(data.message || "Queued for campus gateway.")}</div>`;
    return;
  }

  if (delayMinutes > 0) {
    const { res, data } = await api("/api/play-token", {
      method: "POST",
      body: JSON.stringify({ actionId }),
    });
    if (!res.ok || !data.token || !data.gatewayUrl) {
      msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize.")}</div>`;
      return;
    }
    try {
      const schedRes = await fetch(`${data.gatewayUrl}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, token: data.token, delayMinutes }),
      });
      const schedData = await schedRes.json().catch(() => ({}));
      if (!schedRes.ok) {
        msgEl.innerHTML = `<div class="error-banner">${escapeHtml(schedData.error || "Schedule failed.")}</div>`;
        return;
      }
      await logAudit(actionId, "lan", "scheduled", `delay ${delayMinutes}m`);
      msgEl.innerHTML = `<div class="success-banner">Scheduled in ${delayMinutes} min on campus gateway.</div>`;
    } catch {
      msgEl.innerHTML = `<div class="error-banner">Cannot reach the alarm gateway. Join church Wi‑Fi, or ask an admin for remote play access.</div>`;
    }
    return;
  }

  const { res, data } = await api("/api/play-token", {
    method: "POST",
    body: JSON.stringify({ actionId }),
  });
  if (!res.ok || !data.token || !data.gatewayUrl) {
    msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize play.")}</div>`;
    return;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const playRes = await fetch(`${data.gatewayUrl}/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionId, token: data.token, loop }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const playData = await playRes.json().catch(() => ({}));
    if (!playRes.ok) {
      msgEl.innerHTML = `<div class="error-banner">${escapeHtml(playData.error || `Gateway error (${playRes.status})`)}</div>`;
      return;
    }
    await logAudit(actionId, "lan", "done", loop ? "loop" : undefined);
    msgEl.innerHTML = `<div class="success-banner">${loop ? "Playing on speakers (looping)." : "Sent to speakers."}</div>`;
  } catch {
    msgEl.innerHTML = `<div class="error-banner">Cannot reach the alarm gateway. Join the church Wi‑Fi network and try again — or ask an admin for remote play access.</div>`;
  }
}

async function stopPlayback(msgEl) {
  if (msgEl) msgEl.innerHTML = "";
  if (canRemotePlay()) {
    const { res, data } = await api("/api/stop-remote", { method: "POST", body: "{}" });
    if (!res.ok) {
      if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Remote stop failed.")}</div>`;
      return;
    }
    await logAudit("__stop__", "remote", "done", "stop");
    if (msgEl) msgEl.innerHTML = `<div class="success-banner">${escapeHtml(data.message || "Stop queued.")}</div>`;
    return;
  }

  const { res, data } = await api("/api/play-token", {
    method: "POST",
    body: JSON.stringify({ actionId: "evacuate.code_green" }),
  });
  if (!res.ok || !data.token || !data.gatewayUrl) {
    if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize stop.")}</div>`;
    return;
  }
  try {
    const stopRes = await fetch(`${data.gatewayUrl}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: data.token }),
    });
    const stopData = await stopRes.json().catch(() => ({}));
    if (!stopRes.ok) {
      if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(stopData.error || "Stop failed.")}</div>`;
      return;
    }
    await logAudit("__stop__", "lan", "done", "stop");
    if (msgEl) msgEl.innerHTML = `<div class="success-banner">Speakers stopped.</div>`;
  } catch {
    if (msgEl) msgEl.innerHTML = `<div class="error-banner">Cannot reach the alarm gateway.</div>`;
  }
}

async function scheduleAction(actionId, label, delayMinutes, msgEl, listEl) {
  await playAction(actionId, msgEl, delayMinutes);
  if (!state.session?.scopes?.includes("remote")) {
    await refreshSchedule(listEl);
  }
}

async function refreshSchedule(listEl) {
  if (!listEl || !state.config) return;
  try {
    const res = await fetch(`${state.config.gatewayUrl}/schedule`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const now = Date.now();
    const pending = (data.jobs || []).filter((j) => j.fireAt > now);
    if (!pending.length) {
      listEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = `
      <div class="card stack" style="padding:0.9rem 1rem">
        <p class="muted" style="margin:0;font-size:0.8rem">Scheduled on gateway</p>
        ${pending
          .map((j) => {
            const secs = Math.max(0, Math.round((j.fireAt - now) / 1000));
            const m = Math.floor(secs / 60);
            const s = secs % 60;
            return `<div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center">
              <span style="font-variant-numeric:tabular-nums">${escapeHtml(j.actionId)} · ${m}:${String(s).padStart(2, "0")}</span>
              <button type="button" class="btn btn-ghost" style="min-height:2.25rem;padding:0.35rem 0.7rem" data-cancel="${escapeHtml(j.id)}">Cancel</button>
            </div>`;
          })
          .join("")}
      </div>`;
    listEl.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`${state.config.gatewayUrl}/schedule/${btn.dataset.cancel}`, {
          method: "DELETE",
        });
        await refreshSchedule(listEl);
      });
    });
  } catch {
    /* offline */
  }
}

function renderBells() {
  const actions = state.config?.bellActions || [];
  const def =
    actions.find((a) => a.id.includes("period_end") || a.id.includes("end")) ||
    actions[0];
  app.innerHTML = `
    <main class="app-shell">
      ${header(state.session.label)}
      <button type="button" class="back-link" data-go="home">← Home</button>
      <div class="stack">
        ${clockHtml()}
        <div>
          <h1 class="page-title">Class bells</h1>
          <p class="muted" style="margin:0">${playHint()} Schedule survives closing this page.</p>
        </div>
        ${
          def
            ? `<div class="card stack">
                <p style="margin:0;font-weight:600">After service</p>
                <p class="muted" style="margin:0;font-size:0.9rem">Service just ended? Queue the bell for 15 minutes.</p>
                <button type="button" class="btn btn-ghost btn-block" data-schedule="${escapeHtml(def.id)}" data-label="${escapeHtml(def.label)}">Ring “${escapeHtml(def.label)}” in 15 min</button>
                <div id="sched-list"></div>
                <div id="sched-msg"></div>
              </div>`
            : ""
        }
        <p class="muted" style="margin:0.5rem 0 0;font-size:0.85rem">Play now</p>
        ${actions.map((a) => `<button type="button" class="btn btn-primary btn-block" data-play="${escapeHtml(a.id)}">${escapeHtml(a.label)}</button>`).join("")}
        <div id="play-msg"></div>
      </div>
    </main>`;
  tickClock();
  void refreshSchedule($("#sched-list"));
}

function renderEvacuate() {
  const actions = state.config?.evacuateActions || [
    { id: "evacuate.code_red", label: "Code Red — Evacuate" },
    { id: "evacuate.code_blue", label: "Code Blue — Lockdown" },
    { id: "evacuate.code_green", label: "Code Green — All clear" },
  ];
  app.innerHTML = `
    <main class="app-shell">
      ${header(state.session.label)}
      <button type="button" class="back-link" data-go="home">← Home</button>
      <div class="stack">
        <div>
          <h1 class="page-title">Emergency codes</h1>
          <p class="muted" style="margin:0">
            ${playHint()} Confirm before sending Red or Blue. Use <strong>Stop speakers</strong> to cut audio mid-play.
          </p>
        </div>
        <label class="checks" style="margin:0">
          <input type="checkbox" id="evac-loop" /> Loop until stopped (lockdown / evacuate)
        </label>
        <button type="button" class="btn btn-ghost btn-block" id="evac-stop" style="border-color: color-mix(in oklab, var(--accent) 35%, var(--line))">
          Stop speakers
        </button>
        ${actions
          .map((a) => {
            const isGreen = a.id.includes("green");
            const cls = isGreen ? "btn-primary" : "btn-danger";
            if (isGreen) {
              return `<button type="button" class="btn ${cls} btn-block" data-play="${escapeHtml(a.id)}">${escapeHtml(a.label)}</button>`;
            }
            return `<button type="button" class="btn ${cls} btn-block" data-arm-evac="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}">${escapeHtml(a.label)}</button>`;
          })
          .join("")}
        <div id="evac-confirm"></div>
        <div id="play-msg"></div>
      </div>
    </main>`;

  document.querySelectorAll("[data-arm-evac]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.armEvac;
      const label = btn.dataset.label || id;
      $("#evac-confirm").innerHTML = `
        <div class="confirm-box stack">
          <p style="margin:0">Confirm play <strong>${escapeHtml(label)}</strong> on campus AI speakers.</p>
          <button type="button" class="btn btn-danger btn-block" data-confirm-evac="${escapeHtml(id)}">Confirm now</button>
          <button type="button" class="btn btn-ghost btn-block" data-cancel-evac>Cancel</button>
        </div>`;
      $("[data-confirm-evac]")?.addEventListener("click", (e) => {
        const actionId = e.currentTarget.dataset.confirmEvac;
        const loop = $("#evac-loop")?.checked;
        $("#evac-confirm").innerHTML = "";
        void playAction(actionId, $("#play-msg"), 0, loop);
      });
      $("[data-cancel-evac]")?.addEventListener("click", () => {
        $("#evac-confirm").innerHTML = "";
      });
    });
  });

  $("#evac-stop")?.addEventListener("click", () => {
    void stopPlayback($("#play-msg"));
  });
}

async function renderAdmin() {
  const { res, data } = await api("/api/admin/pins");
  const pins = res.ok ? data.pins || [] : [];
  app.innerHTML = `
    <main class="app-shell">
      ${header(state.session.label)}
      <button type="button" class="back-link" data-go="home">← Home</button>
      <div class="stack">
        <div>
          <h1 class="page-title">PIN admin</h1>
          <p class="muted" style="margin:0">Hashed PINs in Cloudflare D1. Check <strong>Remote play</strong> only for people trusted to ring speakers from cell.</p>
        </div>
        <form class="card stack" id="pin-form">
          <div class="field"><label>Label</label><input name="label" required placeholder="Office desk" /></div>
          <div class="field"><label>6-digit PIN</label><input name="pin" inputmode="numeric" maxlength="6" pattern="\\d{6}" required /></div>
          <div class="checks">
            <label><input type="checkbox" name="bells" checked /> Class bells</label>
            <label><input type="checkbox" name="evacuate" /> Evacuation</label>
            <label><input type="checkbox" name="admin" /> Admin</label>
            <label><input type="checkbox" name="remote" /> Remote play (off campus)</label>
          </div>
          <button class="btn btn-primary" type="submit">Add PIN</button>
          <div id="admin-msg"></div>
        </form>
        <div class="card" style="overflow-x:auto">
          <table class="table">
            <thead><tr><th>Label</th><th>Scopes</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${pins
                .map(
                  (p) => `<tr>
                  <td>${escapeHtml(p.label)}</td>
                  <td>${escapeHtml((p.scopes || []).join(", "))}</td>
                  <td>${p.active ? "Active" : "Revoked"}</td>
                  <td><button type="button" class="btn btn-ghost" style="min-height:2.25rem;padding:0.4rem 0.7rem" data-toggle="${escapeHtml(p.id)}" data-active="${p.active ? "1" : "0"}">${p.active ? "Revoke" : "Restore"}</button></td>
                </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </main>`;

  $("#pin-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const scopes = [];
    if (fd.get("bells")) scopes.push("bells");
    if (fd.get("evacuate")) scopes.push("evacuate");
    if (fd.get("admin")) scopes.push("admin");
    if (fd.get("remote")) scopes.push("remote");
    const { res, data } = await api("/api/admin/pins", {
      method: "POST",
      body: JSON.stringify({
        label: fd.get("label"),
        pin: fd.get("pin"),
        scopes,
      }),
    });
    const msg = $("#admin-msg");
    if (!res.ok) {
      msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Failed")}</div>`;
      return;
    }
    msg.innerHTML = `<div class="success-banner">PIN created.</div>`;
    await renderAdmin();
  });

  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api("/api/admin/pins", {
        method: "PATCH",
        body: JSON.stringify({
          id: btn.dataset.toggle,
          active: btn.dataset.active !== "1",
        }),
      });
      await renderAdmin();
    });
  });
}

function render() {
  if (!state.session) {
    renderPin();
    return;
  }
  if (state.route === "home") renderHome();
  else if (state.route === "bells") renderBells();
  else if (state.route === "evacuate") renderEvacuate();
  else if (state.route === "admin") void renderAdmin();
  else renderHome();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go],[data-action],[data-play],[data-schedule]");
  if (!t) return;
  if (t.dataset.go) setRoute(t.dataset.go);
  if (t.dataset.action === "logout") {
    void api("/api/auth/logout", { method: "POST" }).then(() => {
      state.session = null;
      setRoute("pin");
    });
  }
  if (t.dataset.play) {
    const loop = state.route === "evacuate" && $("#evac-loop")?.checked;
    void playAction(t.dataset.play, $("#play-msg"), 0, loop);
  }
  if (t.dataset.schedule) {
    void scheduleAction(
      t.dataset.schedule,
      t.dataset.label || t.dataset.schedule,
      15,
      $("#sched-msg"),
      $("#sched-list"),
    );
  }
});

async function checkGateway() {
  // Remote users never need LAN gateway reachability — don't flip the status to "not on Wi‑Fi".
  if (canRemotePlay()) {
    const row = $(".status-row");
    if (row) {
      const [dot, text] = statusCopy();
      const dotEl = row.querySelector(".dot");
      const span = row.querySelector("span:last-child");
      if (dotEl) dotEl.className = `dot ${dot}`;
      if (span) span.textContent = text;
    }
    return;
  }

  if (!state.config?.gatewayUrl) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${state.config.gatewayUrl}/health`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    state.gatewayStatus = res.ok ? "online" : "offline";
  } catch {
    state.gatewayStatus = "offline";
  }
  const row = $(".status-row");
  if (row && state.session) {
    const [dot, text] = statusCopy();
    const dotEl = row.querySelector(".dot");
    const span = row.querySelector("span:last-child");
    if (dotEl) dotEl.className = `dot ${dot}`;
    if (span) span.textContent = text;
  }
}

async function boot() {
  const cfg = await api("/api/config");
  state.config = cfg.data;
  const sess = await api("/api/auth/session");
  if (sess.res.ok && sess.data.authenticated) {
    state.session = { label: sess.data.label, scopes: sess.data.scopes };
    state.route = "home";
  }
  render();
  void checkGateway();
  setInterval(() => {
    tickClock();
    void checkGateway();
    if (state.route === "bells") void refreshSchedule($("#sched-list"));
  }, 2000);
}

boot();
