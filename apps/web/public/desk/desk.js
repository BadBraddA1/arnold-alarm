const TZ = "America/Chicago";
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");

const NAV = [
  { id: "overview", label: "Overview", icon: "◫" },
  { id: "test", label: "Speaker test", icon: "☎" },
  { id: "speakers", label: "Speakers", icon: "◎" },
  { id: "activity", label: "Activity", icon: "☰" },
  { id: "staff", label: "Staff PINs", icon: "✦" },
  { id: "bells", label: "Class bells", icon: "◷" },
  { id: "system", label: "System", icon: "⚙" },
];

let state = {
  session: null,
  config: null,
  section: "overview",
  overview: null,
  speakersData: null,
  pins: [],
  events: [],
  message: null,
  expiresAt: null,
  idleSec: 3 * 60 * 60,
  lastActivityAt: Date.now(),
  fobDevices: [],
  _speakersTimer: null,
  _pollTimer: null,
  _testNotifyPoll: null,
  _pinEditId: null,
};

let idleTimer = null;
let ablyRealtime = null;
let systemPollTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  void ensureLiveSync();
}

async function forceLogout(reason) {
  stopLiveSync();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  state.session = null;
  state.expiresAt = null;
  state.message = reason ? { kind: "err", text: reason } : null;
  render();
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

function isAdmin() {
  return !!state.session?.scopes?.includes("admin");
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

function actionLabel(actionId) {
  const bells = state.config?.bellActions || [];
  const evacs = state.config?.evacuateActions || [];
  const hit = [...bells, ...evacs].find((a) => a.id === actionId);
  if (actionId === "__all_clear__") return "Stop & All clear";
  if (actionId === "__stop__") return "Stop speakers";
  if (actionId === "test.speakers") return "Speaker check";
  if (actionId.startsWith("test.phone:")) return "Desk phone test call";
  if (actionId.startsWith("test.speaker:")) return "Speaker bell test";
  if (actionId === "bells.first") return "First bell";
  if (actionId === "bells.second") return "Second bell";
  if (actionId === "__system_armed__") return "System armed";
  if (actionId === "__system_unarmed__") return "System unarmed";
  if (actionId === "__void_schedule__") return "Void schedule";
  return hit?.label || actionId;
}

function statusPlain(status) {
  if (status === "status") return "status change";
  if (status === "queued") return "queued";
  if (status === "scheduled") return "scheduled";
  if (status === "done") return "played";
  if (status === "held") return "held";
  if (status === "voided") return "voided";
  if (status === "error") return "error";
  return status;
}

function statusClass(status, actionId) {
  if (isSystemStatusEvent(actionId)) {
    return actionId === "__system_armed__" ? "ok" : "held";
  }
  if (status === "done" || status === "queued" || status === "scheduled") return "ok";
  if (status === "held") return "held";
  if (status === "status") return "neutral";
  if (status === "error") return "bad";
  return "neutral";
}

function isSystemStatusEvent(actionId) {
  return actionId === "__system_armed__" || actionId === "__system_unarmed__";
}

function eventStatusLabel(e) {
  if (isSystemStatusEvent(e.actionId)) {
    return e.actionId === "__system_armed__" ? "Armed" : "Unarmed";
  }
  return statusPlain(e.status);
}

function eventDetail(e) {
  if (isSystemStatusEvent(e.actionId)) {
    if (e.actionId === "__system_unarmed__") {
      return e.detail || "Plays held until re-armed";
    }
    return "—";
  }
  return [e.mode, e.detail].filter(Boolean).join(" · ") || "—";
}

function lastPlayEvent(events) {
  return (events || []).find((e) => !isSystemStatusEvent(e.actionId));
}

function testNotifyStatusLabel(status) {
  const map = {
    pending: "Waiting",
    ringing: "Ringing…",
    answered: "Answered",
    playing_prompt: "Playing prompt",
    delayed: "Pressed 0 — delay",
    acknowledged: "Acknowledged",
    no_answer: "No answer",
    failed: "Failed",
  };
  return map[status] || status;
}

function testNotifyStatusClass(status) {
  if (status === "delayed") return "held";
  if (status === "acknowledged") return "ok";
  if (status === "ringing" || status === "answered" || status === "playing_prompt") return "neutral";
  if (status === "no_answer" || status === "failed") return "bad";
  return "neutral";
}

function testNotifyDetail(ext) {
  if (ext.digit === "0") return "Delay requested";
  if (ext.status === "acknowledged") return "Heard prompt · goodbye";
  if (ext.status === "delayed") return "Delay confirmed · goodbye";
  if (ext.error) return ext.error;
  return "—";
}

function renderTestNotifyBoard(report) {
  if (!report) {
    return `<p class="muted" style="margin:0">No desk notify run yet. Run speaker check to ring configured extensions.</p>`;
  }
  if (report.configError && !report.extensions?.length) {
    return `<div class="error-banner" style="margin:0">${escapeHtml(report.configError)}</div>`;
  }
  if (!report.extensions?.length) {
    return `<p class="muted" style="margin:0">No desk notify run yet. Run speaker check to ring configured extensions.</p>`;
  }
  const when = formatCentral(new Date(report.finishedAt || report.startedAt).toISOString());
  const live = report.state === "ringing";
  let summary = live
    ? "Live — desk phones ringing now."
    : `Last run ${when}`;
  if (report.requestedBy) summary += ` · ${report.requestedBy}`;
  if (report.delayed && report.delayedBy?.length) {
    const names = report.delayedBy.map((ext) => {
      const row = report.extensions.find((e) => e.ext === ext);
      return row ? `${row.label} (${ext})` : ext;
    });
    summary += ` · delay by ${names.join(", ")}`;
  } else if (report.delayed) {
    summary += ` · horns delayed ${report.delayMinutes}m`;
  }
  if (report.notifyOnly) summary += " · notify-only (horns skipped)";
  if (report.configError) {
    return `
      <div class="error-banner" style="margin:0 0 0.65rem">${escapeHtml(report.configError)}</div>
      ${report.extensions?.length ? renderTestNotifyBoardTable(report, summary) : ""}`;
  }
  return renderTestNotifyBoardTable(report, summary);
}

function renderTestNotifyBoardTable(report, summary) {
  return `
    <p class="muted" style="margin:0 0 0.65rem">${escapeHtml(summary)}</p>
    <div class="audit-table-wrap">
      <table class="table">
        <thead><tr><th>Ext</th><th>Desk phone</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>${report.extensions
          .map(
            (e) => `<tr>
              <td>${escapeHtml(e.ext)}</td>
              <td>${escapeHtml(e.label)}</td>
              <td><span class="status-pill ${testNotifyStatusClass(e.status)}">${escapeHtml(testNotifyStatusLabel(e.status))}</span></td>
              <td class="muted">${escapeHtml(testNotifyDetail(e))}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>
    </div>`;
}

async function refreshTestNotifyPanel() {
  const el = $("#test-notify-board");
  if (!el) return;
  const { res, data } = await api("/api/admin/test-notify");
  if (!res.ok) {
    el.innerHTML = `<p class="error-banner" style="margin:0">${escapeHtml(data.error || "Could not load desk notify status.")}</p>`;
    return;
  }
  el.innerHTML = renderTestNotifyBoard(data.report);
  if (data.report?.state === "ringing") armTestNotifyPoll();
  else stopTestNotifyPoll();
}

function armTestNotifyPoll() {
  if (state._testNotifyPoll) return;
  state._testNotifyPoll = setInterval(() => void refreshTestNotifyPanel(), 1500);
}

function stopTestNotifyPoll() {
  if (state._testNotifyPoll) {
    clearInterval(state._testNotifyPoll);
    state._testNotifyPoll = null;
  }
}

const CAMPUS_PHONES = [
  { ext: "0011", label: "Left desk" },
  { ext: "0014", label: "Elders office" },
  { ext: "0015", label: "Right desk" },
  { ext: "0023", label: "Adin's phone" },
];

function phoneTestGridHtml() {
  return `<div class="phone-test-grid">${CAMPUS_PHONES.map(
    (p) => `<button type="button" class="btn btn-ghost phone-test-btn" data-test-phone="${escapeHtml(p.ext)}" data-test-phone-label="${escapeHtml(p.label)}">
        <span class="phone-test-label">${escapeHtml(p.label)}</span>
        <span class="phone-test-ext muted">${escapeHtml(p.ext)}</span>
      </button>`,
  ).join("")}</div>`;
}

async function testCallPhone(ext, label, btn) {
  const msgEl = $("#phone-test-msg");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-busy");
  }
  if (msgEl) {
    msgEl.innerHTML = `<p class="muted" style="margin:0">Calling ${escapeHtml(label)} (${escapeHtml(ext)})… pick up that phone.</p>`;
  }
  void refreshTestNotifyPanel();
  armTestNotifyPoll();
  try {
    await playAction(`test.phone:${ext}`, msgEl);
  } catch (err) {
    if (msgEl) {
      msgEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message || "Call failed.")}</div>`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
    setTimeout(() => void refreshTestNotifyPanel(), 800);
    setTimeout(() => void refreshTestNotifyPanel(), 4000);
    setTimeout(() => stopTestNotifyPoll(), 60_000);
  }
}

function wirePhoneTestButtons() {
  document.querySelectorAll("[data-test-phone]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ext = btn.getAttribute("data-test-phone");
      const label = btn.getAttribute("data-test-phone-label") || ext;
      if (ext) void testCallPhone(ext, label, btn);
    });
  });
}

async function runSpeakerCheck(msgEl) {
  void refreshTestNotifyPanel();
  armTestNotifyPoll();
  try {
    await playAction("test.speakers", msgEl);
  } finally {
    setTimeout(() => void refreshTestNotifyPanel(), 800);
    setTimeout(() => void refreshTestNotifyPanel(), 4000);
    setTimeout(() => stopTestNotifyPoll(), 90_000);
  }
}

function evacPhaseLabel(phase) {
  if (phase === "red") return "Code Red active";
  if (phase === "blue") return "Code Blue active";
  return "Idle";
}

function applyArmedState(armed) {
  if (!state.config) state.config = {};
  state.config.armed = armed !== false;
  if (state.overview) state.overview.armed = state.config.armed;
}

function applyEvacPhase(phase) {
  if (!state.config) state.config = {};
  state.config.evacPhase = phase || "idle";
  if (state.overview) state.overview.evacPhase = state.config.evacPhase;
}

async function loadConfig() {
  const { res, data } = await api("/api/config");
  if (res.ok) state.config = data;
}

async function loadOverview() {
  const { res, data } = await api("/api/admin/overview");
  if (!res.ok) throw new Error(data.error || "Could not load overview.");
  state.overview = data;
  if (state.config) {
    state.config.armed = data.armed;
    state.config.evacPhase = data.evacPhase;
  }
  return data;
}

async function loadSpeakers() {
  const { res, data } = await api("/api/admin/speakers");
  if (!res.ok) throw new Error(data.error || "Could not load speakers.");
  state.speakersData = data;
  return data;
}

async function loadActivity() {
  const { res, data } = await api("/api/audit?limit=120");
  if (!res.ok) throw new Error(data.error || "Could not load activity.");
  state.events = data.events || [];
  return state.events;
}

async function loadPins() {
  const { res, data } = await api("/api/admin/pins");
  if (!res.ok) throw new Error(data.error || "Could not load PINs.");
  state.pins = data.pins || [];
  return state.pins;
}

function stopLiveSync() {
  if (systemPollTimer) {
    clearInterval(systemPollTimer);
    systemPollTimer = null;
  }
  if (ablyRealtime) {
    ablyRealtime.close();
    ablyRealtime = null;
  }
}

async function ensureLiveSync() {
  if (!state.session || !isAdmin()) return;
  stopLiveSync();
  systemPollTimer = setInterval(() => void pollSystem(), 12_000);
  try {
    await loadAblySdk();
    const { res, data } = await api("/api/ably/token");
    if (!res.ok) return;
    ablyRealtime = new window.Ably.Realtime.Promise({ authCallback: (_, cb) => cb(null, data.tokenRequest) });
    const channel = ablyRealtime.channels.get(data.channel || "arnold-alarm:system");
    channel.subscribe("armed", (msg) => {
      const payload = msg.data || {};
      if (typeof payload.armed === "boolean") applyArmedState(payload.armed);
      if (state.section === "overview") void refreshOverviewPanel();
    });
    channel.subscribe("evac", (msg) => {
      const payload = msg.data || {};
      if (payload.phase) applyEvacPhase(payload.phase);
      if (state.section === "overview") void refreshOverviewPanel();
    });
    channel.subscribe("activity", () => {
      if (state.section === "overview" || state.section === "activity") void refreshSectionData();
    });
    channel.subscribe("test-notify", () => {
      if (state.section === "test" || state.section === "system" || state.section === "overview") {
        void refreshTestNotifyPanel();
      }
    });
  } catch (err) {
    console.warn("[desk] Ably unavailable", err);
  }
}

function loadAblySdk() {
  if (window.Ably) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.ably.com/lib/ably.min-2.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Ably SDK"));
    document.head.appendChild(s);
  });
}

async function pollSystem() {
  try {
    const { res, data } = await api("/api/system");
    if (!res.ok) return;
    if (typeof data.armed === "boolean") applyArmedState(data.armed);
    if (data.evacPhase) applyEvacPhase(data.evacPhase);
  } catch {
    /* ignore */
  }
}

async function toggleArmed() {
  const next = state.config?.armed === false;
  const { res, data } = await api("/api/admin/armed", {
    method: "POST",
    body: JSON.stringify({ armed: next }),
  });
  if (!res.ok) throw new Error(data.error || "Could not update arm status.");
  applyArmedState(data.armed);
  return data;
}

async function playAction(actionId, msgEl, delayMinutes = 0) {
  if (msgEl) msgEl.innerHTML = `<p class="muted" style="margin:0">Sending…</p>`;

  const onLan = await gatewayReachable();
  if (onLan && delayMinutes === 0) {
    const { res, data } = await api("/api/play-token", {
      method: "POST",
      body: JSON.stringify({ actionId }),
    });
    if (res.ok && !data.held && data.armed !== false && data.token && data.gatewayUrl) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(
          () => ctrl.abort(),
          actionId === "test.speakers" ? 45000 : actionId.startsWith("test.phone:") ? 90000 : 20000,
        );
        const playRes = await fetch(`${data.gatewayUrl}/play`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionId, token: data.token }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (playRes.ok) {
          if (data.evacPhase) applyEvacPhase(data.evacPhase);
          const text = actionId.startsWith("test.phone:")
            ? "Test call finished — check the phone you rang."
            : actionId === "test.speakers"
              ? "Speaker check running on campus."
              : actionId.startsWith("test.speaker:")
                ? "Bell sound playing on that speaker at its bell volume."
                : "Playing now on campus speakers.";
          if (msgEl) msgEl.innerHTML = `<div class="success-banner">${escapeHtml(text)}</div>`;
          return data;
        }
      } catch {
        /* fall through to admin queue */
      }
    }
  }

  const { res, data } = await api("/api/admin/play", {
    method: "POST",
    body: JSON.stringify({ actionId, delayMinutes }),
  });
  if (!res.ok) {
    const err = data.error || "Play failed.";
    if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(err)}</div>`;
    throw new Error(err);
  }
  if (data.held || data.armed === false) {
    const text = data.message || "System unarmed — command recorded, speakers silent.";
    if (msgEl) msgEl.innerHTML = `<div class="success-banner">${escapeHtml(text)}</div>`;
    return data;
  }
  if (data.evacPhase) applyEvacPhase(data.evacPhase);
  const ok = actionId.startsWith("test.phone:")
    ? data.message || "Test call queued — pick up that desk phone."
    : data.message || (delayMinutes > 0 ? "Scheduled on campus." : "Queued on campus.");
  if (msgEl) msgEl.innerHTML = `<div class="success-banner">${escapeHtml(ok)}</div>`;
  return data;
}

async function gatewayReachable() {
  if (!state.config?.gatewayUrl) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${state.config.gatewayUrl}/health`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
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

function delayMinutesUntilBuildingTime(hour12, minute, ampm) {
  let h = Number(hour12) % 12;
  if (String(ampm).toUpperCase() === "PM") h += 12;
  if (String(ampm).toUpperCase() === "AM" && Number(hour12) === 12) h = 0;
  const m = Math.max(0, Math.min(59, Number(minute) || 0));
  const now = new Date();
  const c = chicagoParts(now);
  let target = chicagoWallToUtcMs(c.year, c.month, c.day, h, m);
  if (target <= now.getTime() + 5_000) {
    const tomorrow = new Date(Date.UTC(c.year, c.month - 1, c.day) + 36 * 3600_000);
    const t = chicagoParts(tomorrow);
    target = chicagoWallToUtcMs(t.year, t.month, t.day, h, m);
  }
  const mins = Math.ceil((target - now.getTime()) / 60_000);
  if (mins < 1 || mins > 12 * 60) return null;
  return mins;
}

function statStrip(data) {
  const armed = data?.armed !== false;
  const gw = data?.gateway || {};
  const speakers = data?.speakers?.items || [];
  const connected = speakers.filter((s) => String(s.state).toUpperCase() === "CONNECTED").length;
  const phase = data?.evacPhase || "idle";
  const last = lastPlayEvent(data?.events) || (data?.events || [])[0];
  return `
    <div class="stat-strip">
      <div class="stat-card">
        <p class="label">Arm state</p>
        <p class="value"><span class="dot ${armed ? "ok" : "warn"}"></span>${armed ? "Armed" : "Unarmed"}</p>
        <p class="hint">${armed ? "Speakers will play" : "Commands held — speakers silent"}</p>
      </div>
      <div class="stat-card">
        <p class="label">Campus gateway</p>
        <p class="value"><span class="dot ${gw.online ? "ok" : "bad"}"></span>${gw.online ? "Online" : "Offline"}</p>
        <p class="hint">${gw.ageSec != null ? `Last seen ${gw.ageSec}s ago` : "No heartbeat yet"}</p>
      </div>
      <div class="stat-card">
        <p class="label">Speakers</p>
        <p class="value"><span class="dot ${connected === speakers.length && speakers.length ? "ok" : "warn"}"></span>${connected}/${speakers.length || "—"} connected</p>
        <p class="hint">${data?.speakers?.ageSec != null ? `Telemetry ${data.speakers.ageSec}s old` : "Waiting for report"}</p>
      </div>
      <div class="stat-card">
        <p class="label">Emergency</p>
        <p class="value"><span class="dot ${phase === "idle" ? "ok" : "bad"}"></span>${escapeHtml(evacPhaseLabel(phase))}</p>
        <p class="hint">${data?.scheduledCount ? `${data.scheduledCount} bell(s) scheduled` : "No pending bells"}</p>
      </div>
      <div class="stat-card">
        <p class="label">Last play</p>
        <p class="value" style="font-size:0.92rem">${last && !isSystemStatusEvent(last.actionId) ? escapeHtml(actionLabel(last.actionId)) : "—"}</p>
        <p class="hint">${last && !isSystemStatusEvent(last.actionId) ? `${escapeHtml(last.label)} · ${escapeHtml(formatCentral(last.createdAt))}` : "No speaker plays yet"}</p>
      </div>
    </div>`;
}

function speakerMiniGrid(speakers, volumes) {
  const items = speakers || [];
  const bySpeaker = volumes?.bellsBySpeaker || {};
  const defaultBell = Number(volumes?.bells ?? 60);
  if (!items.length) {
    return `<p class="muted" style="margin:0">No speaker telemetry yet. Gateway publishes every few seconds when online.</p>`;
  }
  return `<div class="speaker-grid">${items
    .map((s) => {
      const ok = String(s.state || "").toUpperCase() === "CONNECTED";
      const bellVol = typeof bySpeaker[s.id] === "number" ? bySpeaker[s.id] : defaultBell;
      return `<div class="speaker-card">
        <p class="name"><span class="dot ${ok ? "ok" : "bad"}" style="display:inline-block;margin-right:0.35rem"></span>${escapeHtml(s.name)}</p>
        <p class="meta">${escapeHtml(String(s.state || "UNKNOWN"))} · ${escapeHtml(String(s.speakerStatus || "—"))}</p>
        <p class="vol">Now ${Number(s.volume) || 0}% · Bell ${bellVol}%</p>
      </div>`;
    })
    .join("")}</div>`;
}

function activityTable(events, limit = 12) {
  const rows = (events || []).slice(0, limit);
  if (!rows.length) return `<p class="muted" style="margin:0">No activity yet.</p>`;
  return `<div class="audit-table-wrap"><table class="table">
    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Status</th><th>Detail</th></tr></thead>
    <tbody>${rows
      .map(
        (e) => `<tr>
          <td>${escapeHtml(formatCentral(e.createdAt))}</td>
          <td>${escapeHtml(e.label)}</td>
          <td>${escapeHtml(actionLabel(e.actionId))}</td>
          <td><span class="status-pill ${statusClass(e.status, e.actionId)}">${escapeHtml(eventStatusLabel(e))}</span></td>
          <td class="muted">${escapeHtml(eventDetail(e))}</td>
        </tr>`,
      )
      .join("")}</tbody></table></div>`;
}

function speakerFullList(data) {
  const speakers = data?.speakers || [];
  const volumes = data?.volumes || {};
  const bySpeaker = volumes.bellsBySpeaker || {};
  const defaultBell = Number(volumes.bells ?? 60);
  if (!speakers.length) {
    return `<p class="muted">No speaker report yet.</p>`;
  }
  return `<ul class="speaker-list">${speakers
    .map((s) => {
      const ok = String(s.state || "").toUpperCase() === "CONNECTED";
      const bellVol = typeof bySpeaker[s.id] === "number" ? bySpeaker[s.id] : defaultBell;
      return `<li class="speaker-row">
        <span class="speaker-dot ${ok ? "speaker-dot--ok" : "speaker-dot--bad"}"></span>
        <div class="speaker-main">
          <div class="speaker-head">
            <span class="speaker-name">${escapeHtml(s.name)}</span>
            <button type="button" class="btn btn-ghost btn-sm" data-test-speaker="${escapeHtml(s.id)}" ${ok ? "" : "disabled"}>Test bell</button>
          </div>
          <span class="speaker-meta">${escapeHtml(String(s.state || "UNKNOWN"))} · now ${Number(s.volume) || 0}% · ${escapeHtml(String(s.speakerStatus || "—"))}</span>
          <label class="speaker-bell-vol">
            <span>Bell <strong class="bell-vol-val">${bellVol}%</strong></span>
            <input type="range" min="20" max="100" step="5" value="${bellVol}" data-bell-speaker="${escapeHtml(s.id)}" />
          </label>
          <div class="speaker-test-msg muted" data-test-msg="${escapeHtml(s.id)}" style="font-size:0.8rem;min-height:1.1em"></div>
        </div>
      </li>`;
    })
    .join("")}</ul>`;
}

function sectionOverviewHtml(data) {
  const armed = data?.armed !== false;
  return `
    ${statStrip(data)}
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Campus speakers</h2>
            <p>Live status from Protect via the Pi gateway</p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="refresh-overview">Refresh</button>
        </div>
        <div id="overview-speakers">${speakerMiniGrid(data?.speakers?.items, data?.volumes)}</div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Quick actions</h2>
            <p>Common desk tasks — use the phone app for emergency panic.</p>
          </div>
        </div>
        <div class="quick-actions">
          <button type="button" class="btn ${armed ? "btn-ghost" : "btn-primary"}" id="toggle-armed">${armed ? "Disarm system" : "Arm system"}</button>
          <button type="button" class="btn btn-ghost" id="speaker-check">Speaker check</button>
          <button type="button" class="btn btn-ghost" id="play-first">First bell</button>
          <button type="button" class="btn btn-ghost" id="play-second">Second bell</button>
        </div>
        <div id="quick-msg" style="margin-top:0.65rem"></div>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-head">
        <div>
          <h2>Recent activity</h2>
          <p>Live feed — Central time</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-section="activity">View all</button>
      </div>
        <div id="overview-activity">${activityTable(data?.events, 8)}</div>
      </div>`;
}

function sectionTestHtml() {
  return `
    <div class="stack">
      <div class="panel stack">
        <div class="panel-head">
          <div>
            <h2>Test one desk phone</h2>
            <p>Calls a single phone from Campus Security — short beep + test clip. No horns, no all-call.</p>
          </div>
        </div>
        ${phoneTestGridHtml()}
        <div id="phone-test-msg"></div>
      </div>
      <div class="panel stack">
        <div class="panel-head">
          <div>
            <h2>Run speaker check</h2>
            <p>Rings configured desk phones first — press 0 on a phone to delay campus horns.</p>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="speaker-check">Run speaker check</button>
        <div id="check-msg"></div>
      </div>
      <div class="panel stack">
        <div class="panel-head">
          <div>
            <h2>Desk phone notify</h2>
            <p>Live while ringing — who answered, acknowledged, delayed, or missed.</p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="refresh-test-notify">Refresh</button>
        </div>
        <div id="test-notify-board"><p class="muted" style="margin:0">Loading…</p></div>
      </div>
    </div>`;
}

function sectionSpeakersHtml(data) {
  const gw = data?.gateway || {};
  const meta = gw.online
    ? "Gateway online"
    : gw.ageSec != null
      ? `Gateway last seen ${gw.ageSec}s ago`
      : "Gateway offline";
  const age =
    data?.ageSec == null
      ? "waiting for first report"
      : data.ageSec < 15
        ? "just updated"
        : `updated ${data.ageSec}s ago`;
  return `
    <div class="panel stack">
      <div class="panel-head">
        <div>
          <h2>All campus speakers</h2>
          <p>${escapeHtml(meta)} · ${escapeHtml(age)}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="refresh-speakers">Refresh</button>
      </div>
      <div id="speakers-list">${speakerFullList(data)}</div>
      <div class="stack" style="border-top:1px solid var(--line);padding-top:0.85rem">
        <h2 style="margin:0;font-size:1rem">Volume profiles</h2>
        <p class="muted" style="margin:0;font-size:0.85rem">Bell volume per speaker. Emergency / PA stays at full on every horn.</p>
        <label class="field">
          <span style="display:flex;justify-content:space-between"><span>Default bell (new speakers)</span><strong id="bell-vol-label">${Number(data?.volumes?.bells ?? 60)}%</strong></span>
          <input type="range" id="bell-vol" min="20" max="100" step="5" value="${Number(data?.volumes?.bells ?? 60)}" />
        </label>
        <label class="field">
          <span style="display:flex;justify-content:space-between"><span>Emergency / PA</span><strong id="evac-vol-label">${Number(data?.volumes?.evac ?? 100)}%</strong></span>
          <input type="range" id="evac-vol" min="50" max="100" step="5" value="${Number(data?.volumes?.evac ?? 100)}" />
        </label>
        <div class="row">
          <button type="button" class="btn btn-primary" id="save-volumes">Save volumes</button>
        </div>
        <div id="volume-msg"></div>
      </div>
    </div>`;
}

function sectionActivityHtml(events) {
  return `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2>Activity log</h2>
          <p>Every command, arm change, and play — last 120 events</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="refresh-activity">Refresh</button>
      </div>
      ${activityTable(events, 120)}
    </div>`;
}

const PIN_SCOPE_META = {
  bells: { label: "Class bells", hint: "Ring first/second bell" },
  evacuate: { label: "Evacuation", hint: "Code Red / Blue / All clear" },
  admin: { label: "Admin", hint: "Arm, staff PINs, speaker mgmt" },
  remote: { label: "Remote play", hint: "Queue plays off campus" },
};

function scopePills(scopes) {
  const list = scopes || [];
  if (!list.length) return `<span class="muted">None</span>`;
  return list
    .map((s) => {
      const meta = PIN_SCOPE_META[s] || { label: s };
      return `<span class="scope-pill scope-pill--${escapeHtml(s)}" title="${escapeHtml(meta.hint || "")}">${escapeHtml(meta.label || s)}</span>`;
    })
    .join("");
}

function scopeChecks(namePrefix, scopes, idPrefix) {
  return Object.entries(PIN_SCOPE_META)
    .map(([key, meta]) => {
      const checked = (scopes || []).includes(key) ? " checked" : "";
      return `<label class="scope-check"><input type="checkbox" name="${escapeHtml(namePrefix)}-${key}" data-scope="${key}"${checked} /> ${escapeHtml(meta.label)}</label>`;
    })
    .join("");
}

function pinStatusLabel(p, self) {
  if (!p.active) return "Revoked";
  if (p.mustChangePin) return "Temp — must change PIN";
  if (self) return "Active · you";
  return "Active";
}

function sectionStaffHtml(pins) {
  const selfId = state.session?.pinId;
  return `
    <div class="stack">
      <div class="panel">
        <div class="panel-head"><div><h2>Add staff PIN</h2><p>Permissions are enforced on every play and admin action.</p></div></div>
        <div class="pin-presets row" style="margin-bottom:0.75rem">
          <span class="muted" style="font-size:0.85rem;align-self:center">Quick presets:</span>
          <button type="button" class="btn btn-ghost btn-sm" data-pin-preset="bells">Bells only</button>
          <button type="button" class="btn btn-ghost btn-sm" data-pin-preset="evacuate">Evac leader</button>
          <button type="button" class="btn btn-ghost btn-sm" data-pin-preset="admin">Full admin</button>
        </div>
        <form class="stack" id="pin-form">
          <div class="field"><label>Label</label><input name="label" required placeholder="Office desk" /></div>
          <div class="field">
            <label>6-digit PIN <span class="muted">(blank for temp — auto-generated)</span></label>
            <input name="pin" inputmode="numeric" maxlength="6" pattern="\\d{6}" placeholder="Optional for temp" />
          </div>
          <div class="checks pin-scope-checks" id="pin-form-scopes">
            ${scopeChecks("add", ["bells", "admin"], "add")}
          </div>
          <label class="scope-check"><input type="checkbox" name="temp" /> Temp PIN (must change on first login)</label>
          <button class="btn btn-primary" type="submit">Add PIN</button>
          <div id="pin-msg"></div>
        </form>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Staff roster</h2><p>Edit scopes, rename, reset PIN, or revoke access.</p></div></div>
        <div class="stack pin-roster">${(pins || [])
          .map((p) => {
            const self = p.id === selfId;
            const open = state._pinEditId === p.id;
            return `<div class="pin-card ${p.active ? "" : "pin-card--revoked"} ${open ? "pin-card--open" : ""}" data-pin-id="${escapeHtml(p.id)}">
              <div class="pin-card-head">
                <div>
                  <strong>${escapeHtml(p.label)}</strong>${self ? ' <span class="scope-pill scope-pill--admin">You</span>' : ""}
                  <div class="pin-card-scopes">${scopePills(p.scopes)}${p.fobId ? ` <span class="scope-pill">Fob: ${escapeHtml(p.fobId)}</span>` : ""}</div>
                </div>
                <div class="pin-card-meta muted">${pinStatusLabel(p, self)}${p.created_at ? ` · ${escapeHtml(formatCentral(p.created_at))}` : ""}</div>
              </div>
              <div class="row pin-card-actions">
                <button type="button" class="btn btn-ghost btn-sm" data-pin-edit="${escapeHtml(p.id)}">${open ? "Close" : "Edit"}</button>
                ${
                  p.active
                    ? `<button type="button" class="btn btn-ghost btn-sm" data-toggle="${escapeHtml(p.id)}" data-active="1"${self ? " disabled title=\"Can't revoke your own PIN while signed in\"" : ""}>Revoke</button>`
                    : `<button type="button" class="btn btn-ghost btn-sm" data-toggle="${escapeHtml(p.id)}" data-active="0">Restore</button>`
                }
              </div>
              ${
                open
                  ? `<form class="stack pin-edit-form" data-pin-form="${escapeHtml(p.id)}" style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--line)">
                <div class="field"><label>Assigned fob <span class="muted">(slug — webhook /fob/SLUG/red)</span></label>
                  <input name="fobId" value="${escapeHtml(p.fobId || "")}" placeholder="lobby" autocomplete="off" /></div>
                <div class="field"><label>Display name</label><input name="label" value="${escapeHtml(p.label)}" required /></div>
                <div class="field"><label>Permissions</label><div class="checks pin-scope-checks">${scopeChecks("edit", p.scopes, p.id)}</div></div>
                <div class="field">
                  <label>Reset PIN <span class="muted">(leave blank to keep current)</span></label>
                  <input name="resetPin" inputmode="numeric" maxlength="6" pattern="\\d{6}" placeholder="New 6-digit PIN" autocomplete="off" />
                </div>
                <label class="scope-check"><input type="checkbox" name="tempReset" /> Generate temp PIN (shown once) if blank</label>
                <label class="scope-check"><input type="checkbox" name="mustChange"${p.mustChangePin ? " checked" : ""} /> Require PIN change on next login</label>
                <div class="row">
                  <button type="submit" class="btn btn-primary btn-sm">Save changes</button>
                </div>
                <div class="pin-edit-msg muted" data-pin-edit-msg="${escapeHtml(p.id)}" style="min-height:1.1em"></div>
              </form>`
                  : ""
              }
            </div>`;
          })
          .join("") || `<p class="muted" style="margin:0">No staff PINs yet.</p>`}
        </div>
      </div>
    </div>`;
}

function sectionBellsHtml() {
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
  return `
    <div class="grid-2">
      <div class="panel stack">
        <div class="panel-head"><div><h2>Building clock</h2><p>${escapeHtml(date)} · Central</p></div></div>
        <div class="clock-time" id="clock-time">${escapeHtml(time)}</div>
        <div class="row" style="margin-top:0.5rem">
          <button type="button" class="btn btn-primary" id="bell-first-now">First bell — now</button>
          <button type="button" class="btn btn-primary" id="bell-second-now">Second bell — now</button>
        </div>
        <div id="bell-play-msg"></div>
      </div>
      <div class="panel stack">
        <div class="panel-head"><div><h2>Schedule</h2><p>Fire at building time (Central) — remote queue</p></div></div>
        <form class="stack" id="sched-form">
          <div class="field">
            <label>Bell</label>
            <select name="actionId">
              <option value="bells.first">First bell</option>
              <option value="bells.second">Second bell</option>
            </select>
          </div>
          <div class="row">
            <div class="field" style="flex:1;min-width:6rem"><label>Hour</label><input name="hour" type="number" min="1" max="12" required /></div>
            <div class="field" style="flex:1;min-width:6rem"><label>Minute</label><input name="minute" type="number" min="0" max="59" required /></div>
            <div class="field" style="flex:1;min-width:6rem"><label>AM/PM</label>
              <select name="ampm"><option>AM</option><option>PM</option></select>
            </div>
          </div>
          <button class="btn btn-ghost" type="submit">Schedule ring</button>
        </form>
        <div id="sched-list"></div>
        <div id="sched-msg"></div>
      </div>
    </div>`;
}

async function loadFobDevices() {
  const { res, data } = await api("/api/admin/fobs");
  if (!res.ok) return [];
  return data.devices || [];
}

function sectionSystemHtml() {
  const armed = state.config?.armed !== false;
  const fobs = state.fobDevices || [];
  return `
    <div class="stack">
      <div class="panel stack">
        <div class="panel-head">
          <div>
            <h2>Fobs</h2>
            <p>Register once — assign slug to staff, use in Alarm Manager webhooks. Staff arm for 3 hours before presses work.</p>
          </div>
        </div>
        <form class="row" id="fob-add-form" style="flex-wrap:wrap;gap:0.5rem">
          <input name="id" placeholder="slug (lobby)" required style="min-width:7rem" />
          <input name="name" placeholder="Display name" required style="flex:1;min-width:10rem" />
          <button type="submit" class="btn btn-primary btn-sm">Add fob</button>
        </form>
        <div id="fob-msg"></div>
        <div class="stack" style="margin-top:0.75rem">${fobs.length ? fobs.map((f) => `<div class="row" style="justify-content:space-between;border-top:1px solid var(--line);padding-top:0.5rem">
          <div><strong>${escapeHtml(f.name)}</strong> <span class="muted">(${escapeHtml(f.id)})</span></div>
          <code style="font-size:0.75rem">/fob/${escapeHtml(f.id)}/red?secret=…</code>
        </div>`).join("") : `<p class="muted" style="margin:0">No fobs registered yet.</p>`}</div>
      </div>
      <div class="panel stack">
        <div class="panel-head">
          <div>
            <h2>Arm / disarm</h2>
            <p>${armed ? "System is armed — plays go to speakers." : "Unarmed — staff commands are held in the log."}</p>
          </div>
          <span class="arm-pill ${armed ? "arm-pill--on" : "arm-pill--off"}">${armed ? "Armed" : "Unarmed"}</span>
        </div>
        <button type="button" class="btn ${armed ? "btn-ghost" : "btn-primary"}" id="toggle-armed">${armed ? "Disarm system" : "Arm system"}</button>
        <div id="arm-msg"></div>
      </div>
      <div class="panel stack">
        <div class="panel-head"><div><h2>Speaker check</h2><p>Desk notify → start tone → TEST ACOC on all horns</p></div></div>
        <button type="button" class="btn btn-ghost" data-section="test">Open speaker test board →</button>
      </div>
      <div class="panel stack">
        <div class="panel-head"><div><h2>Mobile panic app</h2><p>Staff phones use the PWA for big emergency buttons and quick bells.</p></div></div>
        <a class="btn btn-ghost" href="/" style="text-decoration:none;display:inline-flex;align-items:center;width:fit-content">Open mobile app →</a>
      </div>
    </div>`;
}

function sidebarHtml() {
  const armed = state.config?.armed !== false;
  return `
    <aside class="desk-sidebar">
      <div class="desk-brand">
        <p class="brand">Arnold <span>Alarm</span></p>
        <p class="sub">Desktop console</p>
        <span class="arm-pill ${armed ? "arm-pill--on" : "arm-pill--off"}" style="margin-top:0.5rem;display:inline-block">${armed ? "Armed" : "Unarmed"}</span>
      </div>
      <nav class="desk-nav">${NAV.map(
        (n) =>
          `<button type="button" class="nav-btn ${state.section === n.id ? "is-active" : ""}" data-section="${n.id}"><span class="icon">${n.icon}</span>${escapeHtml(n.label)}</button>`,
      ).join("")}</nav>
      <div class="desk-foot">
        <div class="who"><strong>${escapeHtml(state.session?.label || "")}</strong>Admin session</div>
        <a class="btn btn-ghost btn-sm" href="/" style="text-decoration:none">Mobile app</a>
        <button type="button" class="btn btn-ghost btn-sm" id="logout">Sign out</button>
      </div>
    </aside>`;
}

function topbarHtml() {
  const item = NAV.find((n) => n.id === state.section);
  const subtitles = {
    overview: "Live campus status, speakers, and recent activity",
    speakers: "Per-horn telemetry, bell volume, and tone tests",
    activity: "Full audit trail for every command",
    staff: "Create, edit scopes, reset PINs, and revoke staff access",
    test: "Desk notify board — who was rung and how each phone responded",
    bells: "Play or schedule class bells from the desk",
    system: "Arm state, speaker check, and mobile app link",
  };
  return `
    <header class="desk-topbar">
      <div>
        <h1>${escapeHtml(item?.label || "Console")}</h1>
        <p class="meta">${escapeHtml(subtitles[state.section] || "")}</p>
      </div>
      <div class="row">
        <span class="muted" style="font-size:0.82rem">Sessions & fob leases — 3 hours</span>
      </div>
    </header>`;
}

async function refreshSectionData() {
  try {
    if (state.section === "overview") {
      state.overview = await loadOverview();
    } else if (state.section === "speakers") {
      state.speakersData = await loadSpeakers();
    } else if (state.section === "activity") {
      state.events = await loadActivity();
    } else if (state.section === "staff") {
      state.pins = await loadPins();
    }
  } catch (err) {
    state.message = { kind: "err", text: err.message || "Refresh failed." };
  }
}

async function refreshOverviewPanel() {
  const speakersEl = $("#overview-speakers");
  const activityEl = $("#overview-activity");
  if (!speakersEl && !activityEl) return;
  try {
    const data = await loadOverview();
    if (speakersEl) speakersEl.innerHTML = speakerMiniGrid(data.speakers?.items, data.volumes);
    if (activityEl) activityEl.innerHTML = activityTable(data.events, 8);
    const strip = $(".stat-strip");
    if (strip) strip.outerHTML = statStrip(data);
  } catch {
    /* ignore background refresh errors */
  }
}

function scheduleBellLabel(actionId) {
  if (actionId === "bells.first") return "First bell";
  if (actionId === "bells.second") return "Second bell";
  return actionId;
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

async function refreshScheduleList() {
  const listEl = $("#sched-list");
  if (!listEl) return;
  const now = Date.now();
  const items = [];
  try {
    const { res, data } = await api("/api/schedule");
    if (res.ok) {
      for (const j of data.jobs || []) {
        const ms = j.fireAt ? Date.parse(j.fireAt) : NaN;
        if (Number.isFinite(ms) && ms > now) {
          items.push({ id: j.id, actionId: j.actionId, fireAtMs: ms });
        }
      }
    }
  } catch {
    /* ignore */
  }
  items.sort((a, b) => a.fireAtMs - b.fireAtMs);
  if (!items.length) {
    listEl.innerHTML = `<p class="muted" style="margin:0">No scheduled bells.</p>`;
    return;
  }
  listEl.innerHTML = items
    .map((j) => {
      const label = scheduleBellLabel(j.actionId);
      const when = formatCentralFireTime(j.fireAtMs);
      const left = formatCountdown(j.fireAtMs - now);
      return `<div class="row" style="justify-content:space-between;border-top:1px solid var(--line);padding-top:0.55rem">
        <div><strong>${escapeHtml(label)}</strong> · ${escapeHtml(when)}<br/><span class="muted">${escapeHtml(left)}</span></div>
        <button type="button" class="btn btn-ghost btn-sm" data-void-id="${escapeHtml(j.id)}">Void</button>
      </div>`;
    })
    .join("");
  listEl.querySelectorAll("[data-void-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const { res } = await api(`/api/schedule/${encodeURIComponent(btn.dataset.voidId)}`, { method: "DELETE" });
      if (res.ok) await refreshScheduleList();
      else btn.disabled = false;
    });
  });
}

function centralDelayMinutes(hour12, minute, ampm) {
  return delayMinutesUntilBuildingTime(hour12, minute, ampm);
}

function wireSpeakersSection() {
  const syncLabels = () => {
    const bell = $("#bell-vol");
    const evac = $("#evac-vol");
    if (bell) $("#bell-vol-label").textContent = `${bell.value}%`;
    if (evac) $("#evac-vol-label").textContent = `${evac.value}%`;
  };
  $("#bell-vol")?.addEventListener("input", syncLabels);
  $("#evac-vol")?.addEventListener("input", syncLabels);
  $("#refresh-speakers")?.addEventListener("click", () => void renderSection("speakers"));
  document.querySelectorAll("[data-bell-speaker]").forEach((input) => {
    input.addEventListener("input", () => {
      const label = input.closest("label")?.querySelector(".bell-vol-val");
      if (label) label.textContent = `${input.value}%`;
    });
  });
  document.querySelectorAll("[data-test-speaker]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.testSpeaker;
      const msg = document.querySelector(`[data-test-msg="${CSS.escape(id)}"]`);
      void playAction(`test.speaker:${id}`, msg);
    });
  });
  $("#save-volumes")?.addEventListener("click", async () => {
    const msg = $("#volume-msg");
    const bells = Number($("#bell-vol")?.value || 60);
    const evac = Number($("#evac-vol")?.value || 100);
    const bellsBySpeaker = {};
    document.querySelectorAll("[data-bell-speaker]").forEach((input) => {
      const id = input.dataset.bellSpeaker;
      if (id) bellsBySpeaker[id] = Number(input.value);
    });
    if (msg) msg.innerHTML = `<p class="muted">Saving…</p>`;
    const { res, data } = await api("/api/admin/volumes", {
      method: "POST",
      body: JSON.stringify({ bells, evac, bellsBySpeaker }),
    });
    if (!res.ok) {
      if (msg) msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Save failed.")}</div>`;
      return;
    }
    if (msg) msg.innerHTML = `<div class="success-banner">${escapeHtml(data.message || "Saved.")}</div>`;
  });
  if (state._speakersTimer) clearInterval(state._speakersTimer);
  state._speakersTimer = setInterval(() => {
    if (state.section === "speakers") void loadSpeakers().then((d) => {
      const list = $("#speakers-list");
      const editing = document.activeElement?.matches?.("[data-bell-speaker], #bell-vol, #evac-vol");
      if (list && !editing) list.innerHTML = speakerFullList(d);
    });
  }, 10_000);
}

function readScopesFromForm(form, prefix) {
  const scopes = [];
  form.querySelectorAll(`[data-scope]`).forEach((el) => {
    if (el.checked) scopes.push(el.getAttribute("data-scope"));
  });
  return scopes;
}

function applyPinPreset(preset) {
  const form = $("#pin-form");
  if (!form) return;
  const map = {
    bells: { bells: true, evacuate: false, admin: false, remote: false },
    evacuate: { bells: true, evacuate: true, admin: false, remote: false },
    admin: { bells: true, evacuate: true, admin: true, remote: false },
  };
  const set = map[preset];
  if (!set) return;
  form.querySelectorAll("[data-scope]").forEach((el) => {
    const key = el.getAttribute("data-scope");
    el.checked = !!set[key];
  });
}

function wireStaffSection() {
  document.querySelectorAll("[data-pin-preset]").forEach((btn) => {
    btn.addEventListener("click", () => applyPinPreset(btn.dataset.pinPreset));
  });

  $("#pin-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const scopes = readScopesFromForm(e.target, "add");
    const temp = !!fd.get("temp");
    const pin = String(fd.get("pin") || "").replace(/\D/g, "");
    const msg = $("#pin-msg");
    if (!scopes.filter((s) => s !== "remote").length) {
      if (msg) msg.innerHTML = `<div class="error-banner">Pick at least one of Class bells, Evacuation, or Admin.</div>`;
      return;
    }
    if (!temp && !/^\d{6}$/.test(pin)) {
      if (msg) msg.innerHTML = `<div class="error-banner">Enter a 6-digit PIN or check Temp PIN.</div>`;
      return;
    }
    const { res, data } = await api("/api/admin/pins", {
      method: "POST",
      body: JSON.stringify({ label: fd.get("label"), pin: pin || undefined, scopes, temp }),
    });
    if (!res.ok) {
      if (msg) msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Failed")}</div>`;
      return;
    }
    if (data.tempPin && msg) {
      msg.innerHTML = `<div class="success-banner">Temp PIN for <strong>${escapeHtml(data.label)}</strong>: <strong style="letter-spacing:0.12em">${escapeHtml(data.tempPin)}</strong> — copy now.</div>`;
    } else if (msg) {
      msg.innerHTML = `<div class="success-banner">PIN added for ${escapeHtml(data.label || String(fd.get("label")))}.</div>`;
    }
    state._pinEditId = null;
    await renderSection("staff");
  });

  document.querySelectorAll("[data-pin-edit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.pinEdit;
      state._pinEditId = state._pinEditId === id ? null : id;
      await renderSection("staff");
    });
  });

  document.querySelectorAll("[data-pin-form]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.dataset.pinForm;
      const fd = new FormData(form);
      const msgEl = form.querySelector(`[data-pin-edit-msg="${id}"]`);
      const scopes = readScopesFromForm(form, "edit");
      if (!scopes.filter((s) => s !== "remote").length) {
        if (msgEl) msgEl.innerHTML = `<span class="error-banner" style="display:block">Pick at least one of Class bells, Evacuation, or Admin.</span>`;
        return;
      }
      const body = {
        id,
        label: String(fd.get("label") || "").trim(),
        scopes,
        mustChangePin: !!fd.get("mustChange"),
        fobId: String(fd.get("fobId") || "").trim() || null,
      };
      const resetPin = String(fd.get("resetPin") || "").replace(/\D/g, "");
      if (resetPin) body.resetPin = resetPin;
      else if (fd.get("tempReset")) body.temp = true;

      const { res, data } = await api("/api/admin/pins", { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) {
        if (msgEl) msgEl.innerHTML = `<span class="error-banner" style="display:block">${escapeHtml(data.error || "Save failed")}</span>`;
        return;
      }
      if (data.tempPin && msgEl) {
        msgEl.innerHTML = `<span class="success-banner" style="display:block">New temp PIN: <strong style="letter-spacing:0.12em">${escapeHtml(data.tempPin)}</strong> — copy now.</span>`;
      } else if (msgEl) {
        msgEl.innerHTML = `<span class="success-banner" style="display:block">Saved.</span>`;
      }
      state.pins = await loadPins();
      setTimeout(() => void renderSection("staff"), data.tempPin ? 8000 : 1200);
    });
  });

  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { res, data } = await api("/api/admin/pins", {
        method: "PATCH",
        body: JSON.stringify({ id: btn.dataset.toggle, active: btn.dataset.active !== "1" }),
      });
      if (!res.ok) {
        alert(data.error || "Could not update PIN");
        return;
      }
      state._pinEditId = null;
      await renderSection("staff");
    });
  });
}

function wireBellsSection() {
  $("#bell-first-now")?.addEventListener("click", () => void playAction("bells.first", $("#bell-play-msg")));
  $("#bell-second-now")?.addEventListener("click", () => void playAction("bells.second", $("#bell-play-msg")));
  $("#sched-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const actionId = String(fd.get("actionId"));
    const delayMinutes = centralDelayMinutes(
      Number(fd.get("hour")),
      Number(fd.get("minute")),
      String(fd.get("ampm")),
    );
    const msg = $("#sched-msg");
    if (delayMinutes == null) {
      if (msg) msg.innerHTML = `<div class="error-banner">Could not schedule that time (past or more than 12 hours away).</div>`;
      return;
    }
    try {
      await playAction(actionId, msg, delayMinutes);
      await refreshScheduleList();
    } catch {
      /* playAction shows error */
    }
  });
  void refreshScheduleList();
}

function wireOverviewSection() {
  $("#toggle-armed")?.addEventListener("click", async () => {
    const msg = $("#quick-msg");
    try {
      const data = await toggleArmed();
      if (msg) msg.innerHTML = `<div class="success-banner">${escapeHtml(data.message || "Updated.")}</div>`;
      await refreshOverviewPanel();
      document.querySelectorAll("#toggle-armed").forEach((b) => {
        b.textContent = state.config?.armed === false ? "Arm system" : "Disarm system";
      });
    } catch (err) {
      if (msg) msg.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  });
  $("#speaker-check")?.addEventListener("click", () => void runSpeakerCheck($("#quick-msg")));
  $("#play-first")?.addEventListener("click", () => void playAction("bells.first", $("#quick-msg")));
  $("#play-second")?.addEventListener("click", () => void playAction("bells.second", $("#quick-msg")));
  $("#refresh-overview")?.addEventListener("click", () => void refreshOverviewPanel());
}

function wireTestSection() {
  $("#speaker-check")?.addEventListener("click", () => void runSpeakerCheck($("#check-msg")));
  $("#refresh-test-notify")?.addEventListener("click", () => void refreshTestNotifyPanel());
  wirePhoneTestButtons();
  void refreshTestNotifyPanel();
}

function wireSystemSection() {
  $("#fob-add-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const msg = $("#fob-msg");
    const { res, data } = await api("/api/admin/fobs", {
      method: "POST",
      body: JSON.stringify({
        id: String(fd.get("id") || "").trim(),
        name: String(fd.get("name") || "").trim(),
      }),
    });
    if (!res.ok) {
      if (msg) msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not add fob.")}</div>`;
      return;
    }
    if (msg) msg.innerHTML = `<div class="success-banner">Added ${escapeHtml(data.name)} (${escapeHtml(data.id)}).</div>`;
    await renderSection("system");
  });
  $("#toggle-armed")?.addEventListener("click", async () => {
    const msg = $("#arm-msg");
    try {
      const data = await toggleArmed();
      if (msg) msg.innerHTML = `<div class="success-banner">${escapeHtml(data.message || "Updated.")}</div>`;
      await renderSection("system");
    } catch (err) {
      if (msg) msg.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  });
}

function wireSectionEvents() {
  document.querySelectorAll("[data-section]").forEach((btn) => {
    btn.addEventListener("click", () => void setSection(btn.dataset.section));
  });
  if (state.section === "overview") wireOverviewSection();
  if (state.section === "test") wireTestSection();
  if (state.section === "speakers") wireSpeakersSection();
  if (state.section === "staff") wireStaffSection();
  if (state.section === "bells") wireBellsSection();
  if (state.section === "system") wireSystemSection();
  $("#refresh-activity")?.addEventListener("click", () => void renderSection("activity"));
  $("#logout")?.addEventListener("click", () => void forceLogout(null));
}

async function renderSection(section) {
  state.section = section;
  const content = $("#desk-content");
  if (!content) return;
  content.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    let html = "";
    if (section === "overview") {
      const data = await loadOverview();
      html = sectionOverviewHtml(data);
    } else if (section === "speakers") {
      const data = await loadSpeakers();
      html = sectionSpeakersHtml(data);
    } else if (section === "activity") {
      const events = await loadActivity();
      html = sectionActivityHtml(events);
    } else if (section === "staff") {
      const pins = await loadPins();
      html = sectionStaffHtml(pins);
    } else if (section === "test") {
      html = sectionTestHtml();
    } else if (section === "bells") {
      html = sectionBellsHtml();
    } else if (section === "system") {
      state.fobDevices = await loadFobDevices();
      html = sectionSystemHtml();
    }
    content.innerHTML = html;
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.section === section);
    });
    const topTitle = $(".desk-topbar h1");
    const topMeta = $(".desk-topbar .meta");
    const item = NAV.find((n) => n.id === section);
    if (topTitle) topTitle.textContent = item?.label || "Console";
    wireSectionEvents();
  } catch (err) {
    content.innerHTML = `<div class="error-banner">${escapeHtml(err.message || "Could not load section.")}</div>`;
  }
}

async function setSection(section) {
  if (state._speakersTimer) {
    clearInterval(state._speakersTimer);
    state._speakersTimer = null;
  }
  if (section !== "test" && section !== "overview" && section !== "system") {
    stopTestNotifyPoll();
  }
  await renderSection(section);
}

function renderDeskShell() {
  app.innerHTML = `
    <div class="desk-shell">
      ${sidebarHtml()}
      <div class="desk-main">
        ${topbarHtml()}
        <div class="desk-scroll" id="desk-content"><p class="muted">Loading…</p></div>
      </div>
    </div>`;
  void renderSection(state.section);
}

function renderForbidden() {
  app.innerHTML = `
    <main class="pin-shell">
      <div class="pin-card stack">
        <h1 style="margin:0;font-family:var(--font-display)">Admin access required</h1>
        <p class="muted" style="margin:0">The desktop console needs an admin-scoped PIN. Use the mobile app for bells and emergency codes.</p>
        <a class="btn btn-primary" href="/" style="text-decoration:none;text-align:center">Open mobile app</a>
      </div>
    </main>`;
}

function renderPin() {
  app.innerHTML = `
    <main class="pin-shell">
      <div class="pin-card stack">
        <div>
          <p class="brand" style="margin:0;font-family:var(--font-display);font-size:1.35rem">Arnold <span style="color:var(--accent)">Alarm</span></p>
          <p class="muted" style="margin:0.35rem 0 0;text-transform:uppercase;letter-spacing:0.08em;font-size:0.78rem">Desktop console</p>
          <h1 style="margin:0.85rem 0 0.25rem;font-family:var(--font-display);font-size:1.35rem">Admin PIN</h1>
          <p class="muted" style="margin:0">Full campus management — speakers, staff, bells, and activity.</p>
        </div>
        <div class="pin-inputs" id="pin-inputs">
          ${[0, 1, 2, 3, 4, 5].map((i) => `<input inputmode="numeric" maxlength="1" data-i="${i}" aria-label="Digit ${i + 1}" />`).join("")}
        </div>
        <div id="pin-msg">${state.message?.kind === "err" ? `<div class="error-banner">${escapeHtml(state.message.text)}</div>` : ""}</div>
        <a class="muted" href="/" style="font-size:0.85rem">← Mobile panic app</a>
      </div>
    </main>`;
  wirePin();
}

function wirePin() {
  const inputs = [...document.querySelectorAll("#pin-inputs input")];
  const msg = $("#pin-msg");
  inputs[0]?.focus();
  async function submit(pin) {
    if (msg) msg.innerHTML = `<p class="muted">Checking PIN…</p>`;
    const { res, data } = await api("/api/auth/pin", { method: "POST", body: JSON.stringify({ pin }) });
    if (!res.ok) {
      if (msg) msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not sign in.")}</div>`;
      inputs.forEach((i) => (i.value = ""));
      inputs[0]?.focus();
      return;
    }
    setSessionFromAuth(data);
    if (data.mustChangePin) {
      window.location.href = "/";
      return;
    }
    if (!data.scopes?.includes("admin")) {
      renderForbidden();
      return;
    }
    renderDeskShell();
  }
  inputs.forEach((input, i) => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(-1);
      if (input.value && i < 5) inputs[i + 1].focus();
      if (inputs.map((x) => x.value).join("").length === 6) void submit(inputs.map((x) => x.value).join(""));
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !input.value && i > 0) inputs[i - 1].focus();
    });
  });
}

function render() {
  if (!state.session) {
    renderPin();
    return;
  }
  if (!isAdmin()) {
    renderForbidden();
    return;
  }
  renderDeskShell();
}

function tickClock() {
  const t = $("#clock-time");
  if (!t) return;
  const now = new Date();
  t.textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(now);
}

async function boot() {
  await loadConfig();
  const sess = await api("/api/auth/session");
  if (sess.res.ok && sess.data.authenticated) {
    setSessionFromAuth(sess.data);
    if (sess.data.mustChangePin) {
      window.location.href = "/";
      return;
    }
    if (!sess.data.scopes?.includes("admin")) {
      renderForbidden();
      return;
    }
  }
  render();
  if (state._pollTimer) clearInterval(state._pollTimer);
  state._pollTimer = setInterval(() => {
    tickClock();
    if (state.section === "bells") void refreshScheduleList();
  }, 2000);
}

["pointerdown", "keydown", "touchstart"].forEach((evt) => {
  document.addEventListener(evt, () => touchActivity(), { passive: true });
});

boot();
