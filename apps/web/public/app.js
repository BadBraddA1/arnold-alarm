const TZ = "America/Chicago";
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

let state = {
  session: null,
  config: null,
  route: "pin",
  gatewayStatus: "checking", // checking | online | offline | protect_down
  gatewayDetail: null,
  remoteGateway: null, // { online, message, ageSec }
  message: null,
  lastActivityAt: Date.now(),
  idleSec: 30 * 60,
  expiresAt: null,
};

let idleTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function touchActivity() {
  state.lastActivityAt = Date.now();
}

function setSessionFromAuth(data) {
  state.session = {
    label: data.label,
    scopes: data.scopes,
    mustChangePin: !!data.mustChangePin,
  };
  state.expiresAt = data.expiresAt || Date.now() + (data.maxAgeSec || 2700) * 1000;
  state.idleSec = data.idleSec || 30 * 60;
  touchActivity();
  armIdleWatch();
}

async function forceLogout(reason) {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  state.session = null;
  state.expiresAt = null;
  state.message = reason
    ? { kind: "err", text: reason }
    : null;
  setRoute("pin");
}

function armIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (!state.session) return;
    const now = Date.now();
    if (state.expiresAt && now >= state.expiresAt) {
      void forceLogout("Session expired — enter PIN again.");
      return;
    }
    const idleMs = (state.idleSec || 1800) * 1000;
    if (now - state.lastActivityAt >= idleMs) {
      void forceLogout("Signed out after inactivity.");
    }
  }, 5000);
}

function setRoute(route) {
  if (state.session?.mustChangePin && route !== "change-pin" && route !== "pin") {
    state.route = "change-pin";
    state.message = null;
    render();
    return;
  }
  state.route = route;
  if (route !== "pin") state.message = null;
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
    if (!state.remoteGateway) {
      return ["warn", "Checking campus gateway…"];
    }
    if (state.remoteGateway.online) {
      return ["ok", "Ready — remote path to campus"];
    }
    return ["warn", state.remoteGateway.message || "Campus gateway not checking in"];
  }
  if (state.gatewayStatus === "online") {
    return ["ok", "Ready — on church network"];
  }
  if (state.gatewayStatus === "protect_down") {
    return ["warn", state.gatewayDetail || "Gateway up — Protect unreachable"];
  }
  if (state.gatewayStatus === "checking") {
    return ["warn", "Checking campus connection…"];
  }
  return ["bad", "Pi offline — join church Wi‑Fi or check alarm-gw"];
}

function playHint() {
  if (canRemotePlay()) {
    return "Remote PINs queue commands — status will say queued until the gateway plays.";
  }
  return "You must be on church Wi‑Fi to play.";
}

function paintStatusRow() {
  const row = $(".status-row");
  if (!row || !state.session) return;
  const [dot, text] = statusCopy();
  const dotEl = row.querySelector(".dot");
  const span = row.querySelector("span:last-child");
  if (dotEl) dotEl.className = `dot ${dot}`;
  if (span) span.textContent = text;
}

function armBadge() {
  const armed = state.config?.armed !== false;
  return armed
    ? `<span class="arm-pill arm-pill--on" title="Speakers will play">Armed</span>`
    : `<span class="arm-pill arm-pill--off" title="Commands recorded; speakers silent">Unarmed</span>`;
}

function header(label) {
  const [dot, text] = statusCopy();
  return `
    <header class="app-header">
      <div>
        <div class="brand-row">
          <div class="brand">Arnold <span>Alarm</span></div>
          ${armBadge()}
        </div>
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
    <main class="app-shell pin-shell">
      <div class="card stack pin-card" style="gap:1.25rem">
        <div>
          <div class="brand" style="margin-bottom:0.35rem">Arnold <span>Alarm</span></div>
          <h1 class="page-title" style="margin-bottom:0.25rem">Staff PIN</h1>
          <p class="muted" style="margin:0">Enter your 6-digit PIN. Sessions end after 45 minutes or 30 minutes idle.</p>
        </div>
        <div class="pin-inputs" id="pin-inputs">
          ${[0, 1, 2, 3, 4, 5].map((i) => `<input inputmode="numeric" maxlength="1" data-i="${i}" aria-label="Digit ${i + 1}" />`).join("")}
        </div>
        <div id="pin-msg">${banner()}</div>
        <p class="muted install-hint">Tip: on iPhone, Share → Add to Home Screen for one-tap access.</p>
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
    setSessionFromAuth(data);
    setRoute(data.mustChangePin ? "change-pin" : "home");
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

function renderChangePin() {
  app.innerHTML = `
    <main class="app-shell pin-shell">
      <div class="card stack pin-card" style="gap:1.1rem">
        <div>
          <div class="brand" style="margin-bottom:0.35rem">Arnold <span>Alarm</span></div>
          <h1 class="page-title" style="margin-bottom:0.25rem">Choose your PIN</h1>
          <p class="muted" style="margin:0">
            Hi ${escapeHtml(state.session.label)} — you signed in with a temporary PIN.
            Set a personal 6-digit PIN now. You cannot use alarm features until this is done.
          </p>
        </div>
        <form class="stack" id="change-pin-form" style="gap:0.85rem">
          <div class="field">
            <label>New 6-digit PIN</label>
            <input name="pin" inputmode="numeric" maxlength="6" pattern="\\d{6}" required autocomplete="new-password" />
          </div>
          <div class="field">
            <label>Confirm PIN</label>
            <input name="confirm" inputmode="numeric" maxlength="6" pattern="\\d{6}" required autocomplete="new-password" />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Save permanent PIN</button>
        </form>
        <div id="change-pin-msg"></div>
        <button type="button" class="btn btn-ghost btn-block" data-action="logout">Sign out</button>
      </div>
    </main>`;

  $("#change-pin-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const msg = $("#change-pin-msg");
    msg.innerHTML = `<p class="muted">Saving…</p>`;
    const { res, data } = await api("/api/auth/change-pin", {
      method: "POST",
      body: JSON.stringify({
        pin: fd.get("pin"),
        confirm: fd.get("confirm"),
      }),
    });
    if (!res.ok) {
      msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not save PIN.")}</div>`;
      return;
    }
    setSessionFromAuth(data);
    state.message = { kind: "ok", text: "PIN saved. You’re ready to use Arnold Alarm." };
    setRoute("home");
  });
}

function renderHome() {
  const s = state.session;
  const canBells = s.scopes.includes("bells") || s.scopes.includes("admin");
  const canEvac = s.scopes.includes("evacuate") || s.scopes.includes("admin");
  const canAdmin = s.scopes.includes("admin");
  const armed = state.config?.armed !== false;
  app.innerHTML = `
    <main class="app-shell">
      ${header(s.label)}
      <div class="stack">
        <div>
          <h1 class="page-title">Choose a panel</h1>
          <p class="muted" style="margin:0">Access is limited to what your PIN allows.</p>
        </div>
        ${
          canAdmin
            ? `<div class="card stack arm-card" style="gap:0.65rem;padding:1rem 1.1rem">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap">
                  <div>
                    <p style="margin:0;font-weight:600">Speaker system</p>
                    <p class="muted" style="margin:0.25rem 0 0;font-size:0.85rem">
                      ${
                        armed
                          ? "Armed — commands play on campus speakers."
                          : "Unarmed — staff can still send commands; they are logged but speakers stay silent."
                      }
                    </p>
                  </div>
                  <button type="button" class="btn ${armed ? "btn-ghost" : "btn-primary"}" id="toggle-armed" style="min-height:2.5rem;padding:0.4rem 1rem">
                    ${armed ? "Disarm" : "Arm system"}
                  </button>
                </div>
                <div id="arm-msg"></div>
              </div>`
            : !armed
              ? `<div class="error-banner" style="margin:0">System is <strong>unarmed</strong> — you can still send commands; speakers will not play until an admin arms the system.</div>`
              : ""
        }
        <div id="last-play" class="last-play muted">Loading last play…</div>
        ${
          canBells || canEvac
            ? `<div class="card stack" style="gap:0.55rem;padding:1rem 1.1rem">
                <p style="margin:0;font-weight:600">Speaker check</p>
                <p class="muted" style="margin:0;font-size:0.85rem">Plays the start tone, then <strong>TEST ACOC</strong> on every campus speaker while you walk the building.</p>
                <button type="button" class="btn btn-ghost btn-block" id="home-test-speakers" style="min-height:2.5rem">Speaker check — all speakers</button>
                <div id="home-test-msg"></div>
              </div>`
            : ""
        }
        <div class="tile-grid">
          ${canBells ? `<button type="button" class="tile" data-go="bells"><h2>Class bells</h2><p>First and second bell — play now or schedule to building time.</p></button>` : ""}
          ${canEvac ? `<button type="button" class="tile" data-go="evacuate"><h2>Emergency codes</h2><p>Code Red, Blue, and Green announcements.</p></button>` : ""}
          ${canAdmin ? `<button type="button" class="tile" data-go="admin"><h2>PIN admin</h2><p>Add or revoke staff PINs.</p></button>` : ""}
        </div>
        <div class="stack" style="gap:0.5rem">
          <p style="margin:0;font-weight:600">Recent activity</p>
          <p class="muted" style="margin:0;font-size:0.85rem">Who activated what, and when (Central).</p>
          <div id="audit-list" class="muted">Loading…</div>
        </div>
        ${banner()}
      </div>
    </main>`;
  void loadAudit();
  $("#toggle-armed")?.addEventListener("click", () => void toggleArmed());
  $("#home-test-speakers")?.addEventListener("click", () => {
    void playAction("test.speakers", $("#home-test-msg"));
  });
}

async function toggleArmed() {
  const msg = $("#arm-msg");
  const next = state.config?.armed === false;
  if (msg) msg.innerHTML = `<p class="muted" style="margin:0">Updating…</p>`;
  const { res, data } = await api("/api/admin/armed", {
    method: "POST",
    body: JSON.stringify({ armed: next }),
  });
  if (!res.ok) {
    if (msg) msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not update arm status.")}</div>`;
    return;
  }
  if (state.config) state.config.armed = data.armed;
  state.message = { kind: "ok", text: data.message || (data.armed ? "System armed." : "System unarmed.") };
  renderHome();
}

async function loadAudit() {
  const el = $("#audit-list");
  const lastEl = $("#last-play");
  if (!el && !lastEl) return;
  const { res, data } = await api("/api/audit");
  if (!res.ok) {
    if (el) el.textContent = "Could not load activity.";
    if (lastEl) lastEl.textContent = "Could not load last play.";
    return;
  }
  const events = data.events || [];
  if (lastEl) {
    if (!events.length) {
      lastEl.className = "last-play muted";
      lastEl.textContent = "No plays yet.";
    } else {
      const e = events[0];
      lastEl.className = "last-play";
      lastEl.innerHTML = `
        <p class="last-play-label">Last play</p>
        <p class="last-play-main">${escapeHtml(actionLabel(e.actionId))}</p>
        <p class="last-play-meta">${escapeHtml(e.label)} · ${escapeHtml(formatCentral(e.createdAt))} · ${escapeHtml(statusPlain(e.status))}</p>`;
    }
  }
  if (!el) return;
  if (!events.length) {
    el.textContent = "No activations yet.";
    return;
  }
  el.className = "audit-list";
  el.innerHTML = events
    .slice(0, 40)
    .map((e) => {
      const ok =
        e.status === "done" ||
        e.status === "queued" ||
        e.status === "scheduled" ||
        e.status === "held";
      const detail = [e.mode, e.detail].filter(Boolean).join(" · ");
      return `<div class="audit-item">
        <div class="when">${escapeHtml(formatCentral(e.createdAt))}</div>
        <p class="who-action">${escapeHtml(e.label)} · ${escapeHtml(actionLabel(e.actionId))}</p>
        ${detail ? `<div class="meta">${escapeHtml(detail)}</div>` : ""}
        <span class="status-pill ${ok ? "ok" : "bad"}${e.status === "held" ? " held" : ""}">${escapeHtml(statusPlain(e.status))}</span>
      </div>`;
    })
    .join("");
}

function statusPlain(status) {
  if (status === "queued") return "queued on campus";
  if (status === "scheduled") return "scheduled";
  if (status === "done") return "played";
  if (status === "held") return "held (unarmed)";
  return status;
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
  if (actionId === "__all_clear__") return "Stop & All clear (Code Green ×2)";
  if (actionId === "__stop__") return "Stop speakers";
  if (actionId === "test.speakers") return "TEST ACOC — speaker check";
  if (actionId === "bells.first") return "First bell";
  if (actionId === "bells.second") return "Second bell";
  if (actionId === "bells.test") return "TEST ACOC";
  if (actionId === "__system_armed__") return "System armed";
  if (actionId === "__system_unarmed__") return "System unarmed";
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

function heldBanner(message) {
  return `<div class="success-banner">${escapeHtml(message || "System is unarmed — command recorded, speakers will not play.")}</div>`;
}

async function playAction(actionId, msgEl, delayMinutes = 0, loop = false) {
  msgEl.innerHTML = `<div class="muted">Sending…</div>`;
  if (actionId === "evacuate.code_green") {
    msgEl.innerHTML = `<div class="error-banner">All clear is only available via <strong>Stop &amp; All clear</strong>.</div>`;
    return;
  }
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
    if (data.held || data.armed === false) {
      msgEl.innerHTML = heldBanner(data.message);
      return;
    }
    await logAudit(actionId, "remote", delayMinutes > 0 ? "scheduled" : "queued", loop ? "loop" : undefined);
    msgEl.innerHTML = `<div class="success-banner">${escapeHtml(data.message || "Queued on campus — not playing yet.")}</div>`;
    return;
  }

  if (delayMinutes > 0) {
    const { res, data } = await api("/api/play-token", {
      method: "POST",
      body: JSON.stringify({ actionId }),
    });
    if (!res.ok) {
      msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize.")}</div>`;
      return;
    }
    if (data.held || data.armed === false) {
      msgEl.innerHTML = heldBanner(data.message);
      return;
    }
    if (!data.token || !data.gatewayUrl) {
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
      msgEl.innerHTML = `<div class="success-banner">Scheduled on campus — will play in ${delayMinutes} min (not playing yet).</div>`;
    } catch {
      msgEl.innerHTML = `<div class="error-banner">Pi offline — join church Wi‑Fi, or ask an admin for remote play access.</div>`;
    }
    return;
  }

  const { res, data } = await api("/api/play-token", {
    method: "POST",
    body: JSON.stringify({ actionId }),
  });
  if (!res.ok) {
    msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize play.")}</div>`;
    return;
  }
  if (data.held || data.armed === false) {
    msgEl.innerHTML = heldBanner(data.message);
    return;
  }
  if (!data.token || !data.gatewayUrl) {
    msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize play.")}</div>`;
    return;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      actionId === "test.speakers"
        ? 45000
        : actionId === "bells.second"
          ? 30000
          : actionId === "bells.first"
            ? 15000
            : 8000,
    );
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
    const playingMsg =
      actionId === "test.speakers" || actionId === "bells.test"
        ? "Playing now — start tone, then TEST ACOC on all speakers (walk the building)."
        : actionId === "bells.second"
          ? "Playing now — Bell 1, 8 second pause, Bell 1 again (all speakers)."
          : actionId === "bells.first"
            ? "Playing now — start bell tone (Lobby + Fellowship)."
            : loop
              ? "Playing now on campus speakers (looping until all clear)."
              : "Playing now on campus speakers.";
    msgEl.innerHTML = `<div class="success-banner">${playingMsg}</div>`;
  } catch {
    msgEl.innerHTML = `<div class="error-banner">Pi offline — join church Wi‑Fi and try again, or ask an admin for remote play access.</div>`;
  }
}

async function stopAndAllClear(msgEl) {
  if (msgEl) msgEl.innerHTML = `<div class="muted">Sending all clear…</div>`;
  if (canRemotePlay()) {
    const { res, data } = await api("/api/stop-remote", { method: "POST", body: "{}" });
    if (!res.ok) {
      if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "All clear failed.")}</div>`;
      return;
    }
    if (data.held || data.armed === false) {
      if (msgEl) msgEl.innerHTML = heldBanner(data.message);
      return;
    }
    await logAudit("__all_clear__", "remote", "queued", "stop + all clear");
    if (msgEl) msgEl.innerHTML = `<div class="success-banner">${escapeHtml(data.message || "All clear queued on campus — not playing yet.")}</div>`;
    return;
  }

  const { res, data } = await api("/api/play-token", {
    method: "POST",
    body: JSON.stringify({ actionId: "__all_clear__" }),
  });
  if (!res.ok) {
    if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize all clear.")}</div>`;
    return;
  }
  if (data.held || data.armed === false) {
    if (msgEl) msgEl.innerHTML = heldBanner(data.message);
    return;
  }
  if (!data.token || !data.gatewayUrl) {
    if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize all clear.")}</div>`;
    return;
  }
  try {
    const clearRes = await fetch(`${data.gatewayUrl}/all-clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: data.token }),
    });
    const clearData = await clearRes.json().catch(() => ({}));
    if (!clearRes.ok) {
      if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(clearData.error || "All clear failed.")}</div>`;
      return;
    }
    await logAudit("__all_clear__", "lan", "done", "stop + all clear");
    if (msgEl) msgEl.innerHTML = `<div class="success-banner">Playing now — All clear (Code Green ×2) on all speakers.</div>`;
  } catch {
    if (msgEl) msgEl.innerHTML = `<div class="error-banner">Pi offline — cannot reach the alarm gateway.</div>`;
  }
}

async function scheduleAction(actionId, label, delayMinutes, msgEl, listEl) {
  await playAction(actionId, msgEl, delayMinutes);
  await refreshSchedule(listEl);
}

function scheduleBellLabel(actionId) {
  if (actionId === "bells.first") return "First bell";
  if (actionId === "bells.second") return "Second bell";
  return actionId || "Bell";
}

function formatCentralFireTime(ms) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

function formatCountdown(msFromNow) {
  const secs = Math.max(0, Math.round(msFromNow / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `in ${h}h ${rm}m`;
  }
  return `in ${m}:${String(s).padStart(2, "0")}`;
}

async function refreshSchedule(listEl) {
  if (!listEl || !state.config) return;
  const now = Date.now();
  /** @type {{ id: string, actionId: string, fireAtMs: number, source: "lan" | "cloud" }[]} */
  const items = [];

  try {
    const res = await fetch(`${state.config.gatewayUrl}/schedule`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      for (const j of data.jobs || []) {
        if (typeof j.fireAt === "number" && j.fireAt > now) {
          items.push({
            id: j.id,
            actionId: j.actionId,
            fireAtMs: j.fireAt,
            source: "lan",
          });
        }
      }
    }
  } catch {
    /* campus gateway offline */
  }

  try {
    const { res, data } = await api("/api/schedule");
    if (res.ok) {
      for (const j of data.jobs || []) {
        const ms = j.fireAt ? Date.parse(j.fireAt) : NaN;
        if (Number.isFinite(ms) && ms > now) {
          items.push({
            id: j.id,
            actionId: j.actionId,
            fireAtMs: ms,
            source: "cloud",
          });
        }
      }
    }
  } catch {
    /* not signed in / offline */
  }

  items.sort((a, b) => a.fireAtMs - b.fireAtMs);

  if (!items.length) {
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = `
    <div class="card stack" style="padding:0.9rem 1rem;gap:0.65rem">
      <p class="muted" style="margin:0;font-size:0.8rem">Scheduled rings (building time)</p>
      ${items
        .map((j) => {
          const label = scheduleBellLabel(j.actionId);
          const when = formatCentralFireTime(j.fireAtMs);
          const left = formatCountdown(j.fireAtMs - now);
          return `<div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center">
            <div style="min-width:0">
              <div style="font-weight:600">${escapeHtml(label)} · ${escapeHtml(when)}</div>
              <div class="muted" style="font-size:0.8rem;font-variant-numeric:tabular-nums">${escapeHtml(left)}</div>
            </div>
            <button type="button" class="btn btn-ghost" style="min-height:2.25rem;padding:0.35rem 0.7rem;flex-shrink:0" data-void-id="${escapeHtml(j.id)}" data-void-source="${escapeHtml(j.source)}">Void</button>
          </div>`;
        })
        .join("")}
    </div>`;

  listEl.querySelectorAll("[data-void-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.voidId;
      const source = btn.dataset.voidSource;
      btn.disabled = true;
      try {
        if (source === "cloud") {
          const { res, data } = await api(`/api/schedule/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            btn.disabled = false;
            alert(data.error || "Could not void schedule.");
            return;
          }
        } else {
          const res = await fetch(`${state.config.gatewayUrl}/schedule/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            btn.disabled = false;
            alert("Could not void schedule.");
            return;
          }
        }
      } catch {
        btn.disabled = false;
        alert("Could not void schedule.");
        return;
      }
      await refreshSchedule(listEl);
    });
  });
}

function chicagoParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** UTC ms for a wall-clock time in America/Chicago. */
function chicagoWallToUtcMs(year, month, day, hour24, minute) {
  let guess = Date.UTC(year, month - 1, day, hour24, minute, 0);
  for (let i = 0; i < 4; i++) {
    const p = chicagoParts(new Date(guess));
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(year, month - 1, day, hour24, minute, 0);
    guess += want - asIfUtc;
  }
  return guess;
}

/**
 * Minutes from now until building (Central) hour:minute AM/PM.
 * Returns null if that time already passed today.
 */
function delayMinutesUntilBuildingTime(hour12, minute, ampm) {
  let h = Number(hour12) % 12;
  if (String(ampm).toUpperCase() === "PM") h += 12;
  if (String(ampm).toUpperCase() === "AM" && Number(hour12) === 12) h = 0;
  const m = Math.max(0, Math.min(59, Number(minute) || 0));
  const now = new Date();
  const c = chicagoParts(now);
  let target = chicagoWallToUtcMs(c.year, c.month, c.day, h, m);
  if (target <= now.getTime() + 5_000) {
    // already passed (or within 5s) — try tomorrow
    const tomorrow = new Date(Date.UTC(c.year, c.month - 1, c.day) + 36 * 3600_000);
    const t = chicagoParts(tomorrow);
    target = chicagoWallToUtcMs(t.year, t.month, t.day, h, m);
  }
  const mins = Math.ceil((target - now.getTime()) / 60_000);
  if (mins < 1) return null;
  if (mins > 12 * 60) return null; // cap 12h
  return mins;
}

function formatBuildingTarget(hour12, minute, ampm) {
  const hh = String(hour12);
  const mm = String(minute).padStart(2, "0");
  return `${hh}:${mm} ${String(ampm).toUpperCase()} Central`;
}

function renderBells() {
  const actions = state.config?.bellActions || [];
  const first = actions.find((a) => a.id === "bells.first") || actions[0];
  const second = actions.find((a) => a.id === "bells.second") || actions[1];
  const nowC = chicagoParts();
  let hour12 = nowC.hour % 12 || 12;
  let ampm = nowC.hour >= 12 ? "PM" : "AM";
  // default schedule suggestion: next round 15 min
  const suggest = new Date(Date.now() + 15 * 60_000);
  const s = chicagoParts(suggest);
  hour12 = s.hour % 12 || 12;
  ampm = s.hour >= 12 ? "PM" : "AM";
  const suggestMin = s.minute;

  app.innerHTML = `
    <main class="app-shell">
      ${header(state.session.label)}
      <button type="button" class="back-link" data-go="home">← Home</button>
      <div class="stack">
        ${clockHtml()}
        <div>
          <h1 class="page-title">Class bells</h1>
          <p class="muted" style="margin:0">${playHint()} Times use the building clock (Central).</p>
        </div>
        <div class="card stack" style="gap:0.75rem">
          <p style="margin:0;font-weight:600">Schedule at building time</p>
          <p class="muted" style="margin:0;font-size:0.85rem">Pick first or second bell and a Central time. Pending rings show below — void anytime before they fire.</p>
          <div class="field">
            <label>Bell</label>
            <select id="bell-which" style="width:100%;min-height:2.75rem;padding:0.5rem 0.75rem;border-radius:var(--radius);border:1px solid var(--line);background:var(--bg);color:inherit;font:inherit">
              ${first ? `<option value="${escapeHtml(first.id)}">${escapeHtml(first.label)}</option>` : ""}
              ${second ? `<option value="${escapeHtml(second.id)}">${escapeHtml(second.label)}</option>` : ""}
            </select>
          </div>
          <div style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap">
            <div class="field" style="margin:0;flex:0 0 4.5rem">
              <label>Hour</label>
              <input id="bell-hour" inputmode="numeric" maxlength="2" value="${hour12}" style="text-align:center" />
            </div>
            <span style="padding-bottom:0.65rem;font-weight:600">:</span>
            <div class="field" style="margin:0;flex:0 0 4.5rem">
              <label>Min</label>
              <input id="bell-min" inputmode="numeric" maxlength="2" value="${String(suggestMin).padStart(2, "0")}" style="text-align:center" />
            </div>
            <div class="field" style="margin:0;flex:0 0 5.5rem">
              <label>AM/PM</label>
              <select id="bell-ampm" style="width:100%;min-height:2.75rem;padding:0.5rem;border-radius:var(--radius);border:1px solid var(--line);background:var(--bg);color:inherit;font:inherit">
                <option value="AM" ${ampm === "AM" ? "selected" : ""}>AM</option>
                <option value="PM" ${ampm === "PM" ? "selected" : ""}>PM</option>
              </select>
            </div>
          </div>
          <button type="button" class="btn btn-primary btn-block" id="bell-schedule">Schedule ring</button>
          <div id="sched-msg"></div>
          <div id="sched-list"></div>
        </div>
        <p class="muted" style="margin:0.5rem 0 0;font-size:0.85rem">Play now</p>
        ${actions.map((a) => `<button type="button" class="btn btn-primary btn-block" data-play="${escapeHtml(a.id)}">${escapeHtml(a.label)}</button>`).join("")}
        <div id="play-msg"></div>
        <p class="muted" style="margin:0;font-size:0.8rem">First bell = start tone on Lobby + Fellowship. Second bell = Bell 1 twice with an 8s gap on all speakers.</p>
      </div>
    </main>`;
  tickClock();
  void refreshSchedule($("#sched-list"));

  $("#bell-schedule")?.addEventListener("click", () => {
    const actionId = $("#bell-which")?.value;
    const hour = Number($("#bell-hour")?.value);
    const minute = Number($("#bell-min")?.value);
    const ap = $("#bell-ampm")?.value || "AM";
    const msg = $("#sched-msg");
    if (!actionId) {
      if (msg) msg.innerHTML = `<div class="error-banner">No bell selected.</div>`;
      return;
    }
    if (!(hour >= 1 && hour <= 12) || !(minute >= 0 && minute <= 59)) {
      if (msg) msg.innerHTML = `<div class="error-banner">Enter a valid time (1–12 : 00–59).</div>`;
      return;
    }
    const delay = delayMinutesUntilBuildingTime(hour, minute, ap);
    if (delay == null) {
      if (msg) {
        msg.innerHTML = `<div class="error-banner">Could not schedule that time (past or more than 12 hours away).</div>`;
      }
      return;
    }
    const label = actionId === "bells.second" ? "Second bell" : "First bell";
    const when = formatBuildingTarget(hour, minute, ap);
    if (msg) {
      msg.innerHTML = `<div class="muted">Scheduling ${escapeHtml(label)} for ${escapeHtml(when)} (in ${delay} min)…</div>`;
    }
    void scheduleAction(actionId, label, delay, msg, $("#sched-list")).then(() => {
      if (msg && !msg.querySelector(".error-banner")) {
        msg.innerHTML = `<div class="success-banner">Scheduled ${escapeHtml(label)} at ${escapeHtml(when)} (in about ${delay} min).</div>`;
      }
    });
  });
}

function evacCodeTone(actionId) {
  if (actionId.includes("blue")) return "blue";
  if (actionId.includes("green") || actionId === "__all_clear__") return "green";
  return "red";
}

function evacButtonMeta(action) {
  const tone = evacCodeTone(action.id);
  const short =
    tone === "blue" ? "Lockdown" : tone === "green" ? "All clear" : "Evacuate";
  const title =
    tone === "blue" ? "Code Blue" : tone === "green" ? "Code Green" : "Code Red";
  return { tone, short, title, className: `btn-code-${tone}` };
}

function wireHoldConfirm(btn, onConfirm) {
  if (!btn) return;
  let holdTimer = null;
  let filled = false;
  const HOLD_MS = 900;

  const clear = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    filled = false;
    btn.classList.remove("is-holding");
    btn.style.setProperty("--hold", "0");
  };

  const start = (e) => {
    e.preventDefault();
    clear();
    btn.classList.add("is-holding");
    const started = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - started) / HOLD_MS);
      btn.style.setProperty("--hold", String(p));
      if (p >= 1 && !filled) {
        filled = true;
        clear();
        onConfirm();
        return;
      }
      if (!filled) holdTimer = setTimeout(tick, 32);
    };
    tick();
  };

  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", clear);
  btn.addEventListener("pointerleave", clear);
  btn.addEventListener("pointercancel", clear);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onConfirm();
    }
  });
}

function renderEvacuate() {
  const actions = (state.config?.evacuateActions || [
    { id: "evacuate.code_red", label: "Code Red — Evacuate" },
    { id: "evacuate.code_blue", label: "Code Blue — Lockdown" },
  ]).filter((a) => !a.id.includes("green"));
  const ordered = [...actions].sort((a, b) => {
    const rank = (id) => (id.includes("red") ? 0 : id.includes("blue") ? 1 : 2);
    return rank(a.id) - rank(b.id);
  });
  app.innerHTML = `
    <main class="app-shell evac-shell">
      ${header(state.session.label)}
      <button type="button" class="back-link" data-go="home">← Home</button>
      <div class="stack evac-top">
        <div>
          <h1 class="page-title">Emergency codes</h1>
          <p class="evac-meta">
            ${playHint()} Hold Confirm to send. Plays on all campus speakers.
          </p>
        </div>
        <label class="checks" style="margin:0">
          <input type="checkbox" id="evac-loop" checked /> Loop until all clear (default for Code Red / Blue)
        </label>
        <div id="evac-confirm"></div>
        <div id="play-msg"></div>
        <div class="evac-speaker-check stack" style="gap:0.45rem">
          <p class="evac-meta">Speaker check / test mode</p>
          <button type="button" class="btn btn-ghost btn-block" data-play="test.speakers">
            Speaker check — all speakers
          </button>
          <p class="evac-meta" style="font-size:0.8rem">Start tone, then TEST ACOC on every AI speaker. Use while walking the building.</p>
        </div>
      </div>
      <div class="evac-thumb-zone">
        <div class="evac-codes">
          ${ordered
            .map((a) => {
              const meta = evacButtonMeta(a);
              return `<button type="button" class="btn ${meta.className} btn-block btn-evac" data-arm-evac="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}" data-tone="${meta.tone}">
                <span>${escapeHtml(meta.title)}</span>
                <span class="btn-evac-sub">${escapeHtml(meta.short)}</span>
              </button>`;
            })
            .join("")}
        </div>
        <div class="evac-all-clear">
          <button type="button" class="btn btn-code-green btn-block btn-evac" id="evac-all-clear">
            <span>Stop &amp; All clear</span>
            <span class="btn-evac-sub">Code Green ×2 on every speaker</span>
          </button>
        </div>
      </div>
    </main>`;

  document.querySelectorAll("[data-arm-evac]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.armEvac;
      const label = btn.dataset.label || id;
      const tone = btn.dataset.tone || evacCodeTone(id);
      $("#evac-confirm").innerHTML = `
        <div class="confirm-box confirm-box--${tone} stack confirm-safe">
          <button type="button" class="btn btn-ghost btn-block" data-cancel-evac>Cancel</button>
          <p style="margin:0;text-align:center">Confirm <strong>${escapeHtml(label)}</strong> on campus AI speakers.</p>
          <button type="button" class="btn btn-code-${tone} btn-block btn-hold" data-confirm-evac="${escapeHtml(id)}" aria-label="Hold to confirm">
            <span class="btn-hold-fill"></span>
            <span class="btn-hold-label">Hold to confirm</span>
          </button>
        </div>`;
      wireHoldConfirm($("[data-confirm-evac]"), () => {
        const loop = $("#evac-loop")?.checked;
        $("#evac-confirm").innerHTML = "";
        void playAction(id, $("#play-msg"), 0, loop);
      });
      $("[data-cancel-evac]")?.addEventListener("click", () => {
        $("#evac-confirm").innerHTML = "";
      });
      $("#evac-confirm")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });

  $("#evac-all-clear")?.addEventListener("click", () => {
    $("#evac-confirm").innerHTML = `
      <div class="confirm-box confirm-box--green stack confirm-safe">
        <button type="button" class="btn btn-ghost btn-block" data-cancel-evac>Cancel</button>
        <p style="margin:0;text-align:center">Issue <strong>All clear</strong>? Code Green plays <strong>twice</strong>. End any lockdown loop first.</p>
        <button type="button" class="btn btn-code-green btn-block btn-hold" id="confirm-all-clear" aria-label="Hold to confirm all clear">
          <span class="btn-hold-fill"></span>
          <span class="btn-hold-label">Hold to confirm all clear</span>
        </button>
      </div>`;
    wireHoldConfirm($("#confirm-all-clear"), () => {
      $("#evac-confirm").innerHTML = "";
      void stopAndAllClear($("#play-msg"));
    });
    $("[data-cancel-evac]")?.addEventListener("click", () => {
      $("#evac-confirm").innerHTML = "";
    });
    $("#evac-confirm")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
          <p class="muted" style="margin:0">Hashed PINs in Cloudflare D1. Grant <strong>Remote play</strong> only to trusted staff — it can ring speakers from anywhere. Sessions auto-end after 45 minutes (30 min idle).</p>
        </div>
        <form class="card stack" id="pin-form">
          <div class="field"><label>Label</label><input name="label" required placeholder="Office desk" /></div>
          <div class="field">
            <label>6-digit PIN <span class="muted">(leave blank if temp — we’ll generate one)</span></label>
            <input name="pin" inputmode="numeric" maxlength="6" pattern="\\d{6}" placeholder="Optional for temp" />
          </div>
          <div class="checks">
            <label><input type="checkbox" name="bells" checked /> Class bells</label>
            <label><input type="checkbox" name="evacuate" /> Evacuation</label>
            <label><input type="checkbox" name="admin" /> Admin</label>
            <label><input type="checkbox" name="remote" /> Remote play (off campus)</label>
            <label><input type="checkbox" name="temp" /> Temp PIN (must change on first login)</label>
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
                  <td>${!p.active ? "Revoked" : p.mustChangePin ? "Temp — awaiting change" : "Active"}</td>
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
    const temp = !!fd.get("temp");
    const pin = String(fd.get("pin") || "").replace(/\D/g, "");
    if (!temp && !/^\d{6}$/.test(pin)) {
      $("#admin-msg").innerHTML = `<div class="error-banner">Enter a 6-digit PIN, or check Temp PIN to auto-generate.</div>`;
      return;
    }
    const { res, data } = await api("/api/admin/pins", {
      method: "POST",
      body: JSON.stringify({
        label: fd.get("label"),
        pin: pin || undefined,
        scopes,
        temp,
      }),
    });
    const msg = $("#admin-msg");
    if (!res.ok) {
      msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Failed")}</div>`;
      return;
    }
    let keep = "";
    if (data.tempPin) {
      keep = `<div class="success-banner">Temp PIN for <strong>${escapeHtml(data.label)}</strong>: <strong style="font-size:1.25rem;letter-spacing:0.12em">${escapeHtml(data.tempPin)}</strong><br/><span class="muted">Copy it now — it won’t be shown again. They must change it on first login.</span></div>`;
    } else {
      keep = `<div class="success-banner">PIN created.</div>`;
    }
    await renderAdmin();
    const after = $("#admin-msg");
    if (after) after.innerHTML = keep;
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
  if (state.session.mustChangePin || state.route === "change-pin") {
    renderChangePin();
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
    void forceLogout(null);
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
  if (!state.session) return;

  if (canRemotePlay()) {
    try {
      const { res, data } = await api("/api/gateway/status");
      if (res.ok) {
        state.remoteGateway = {
          online: !!data.online,
          message: data.message,
          ageSec: data.ageSec,
        };
      } else {
        state.remoteGateway = {
          online: false,
          message: "Could not check campus gateway.",
          ageSec: null,
        };
      }
    } catch {
      state.remoteGateway = {
        online: false,
        message: "Could not check campus gateway.",
        ageSec: null,
      };
    }
    paintStatusRow();
    return;
  }

  if (!state.config?.gatewayUrl) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch(`${state.config.gatewayUrl}/health`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) {
      state.gatewayStatus = "offline";
      state.gatewayDetail = null;
    } else {
      const data = await res.json().catch(() => ({}));
      if (data.protect && data.protect.ok === false) {
        state.gatewayStatus = "protect_down";
        state.gatewayDetail =
          data.protect.error || "Gateway up — Protect unreachable";
      } else {
        state.gatewayStatus = "online";
        state.gatewayDetail = null;
      }
    }
  } catch {
    state.gatewayStatus = "offline";
    state.gatewayDetail = null;
  }
  paintStatusRow();
}

async function boot() {
  const cfg = await api("/api/config");
  state.config = cfg.data;
  const sess = await api("/api/auth/session");
  if (sess.res.ok && sess.data.authenticated) {
    setSessionFromAuth(sess.data);
    state.route = sess.data.mustChangePin ? "change-pin" : "home";
  }
  render();
  void checkGateway();
  setInterval(() => {
    tickClock();
    void checkGateway();
    if (state.route === "bells") void refreshSchedule($("#sched-list"));
  }, 2000);
}

["pointerdown", "keydown", "touchstart"].forEach((evt) => {
  document.addEventListener(evt, () => touchActivity(), { passive: true });
});

boot();
