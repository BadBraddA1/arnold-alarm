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
  idleSec: 3 * 60 * 60,
  expiresAt: null,
  fob: null,
  fobPairPoll: null,
  _speakersTimer: null,
};

let idleTimer = null;
/** @type {import("ably").Realtime | null} */
let ablyRealtime = null;
let ablyChannelName = "arnold-alarm:system";
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
  state.idleSec = data.idleSec || 3 * 60 * 60;
  touchActivity();
  armIdleWatch();
  void ensureLiveSync();
  void loadFobStatus();
}

async function loadFobStatus() {
  if (!state.session) return;
  const { res, data } = await api("/api/fob/status");
  if (res.ok) state.fob = data;
}

async function armFob() {
  touchActivity();
  const { res, data } = await api("/api/fob/arm", { method: "POST", body: "{}" });
  if (!res.ok) {
    state.message = { kind: "err", text: data.error || "Could not arm fob." };
    renderHome();
    return;
  }
  state.message = { kind: "ok", text: data.message || "Fob armed for 3 hours." };
  await loadFobStatus();
  renderHome();
}

async function disarmFob() {
  touchActivity();
  const { res, data } = await api("/api/fob/disarm", { method: "POST", body: "{}" });
  if (!res.ok) {
    state.message = { kind: "err", text: data.error || "Could not disarm fob." };
    renderHome();
    return;
  }
  state.message = { kind: "ok", text: data.message || "Fob disarmed." };
  await loadFobStatus();
  renderHome();
}

async function startFobPairing() {
  touchActivity();
  const { res, data } = await api("/api/fob/pair/start", { method: "POST", body: "{}" });
  if (!res.ok) {
    state.message = { kind: "err", text: data.error || "Could not start fob link." };
    renderHome();
    return;
  }
  state.message = {
    kind: "ok",
    text: data.message || "Hold button 4 (green) on your fob now.",
  };
  await loadFobStatus();
  renderHome();
  startFobPairPoll();
}

function startFobPairPoll() {
  if (state.fobPairPoll) clearInterval(state.fobPairPoll);
  state.fobPairPoll = setInterval(async () => {
    if (!state.session || state.route !== "home") {
      clearInterval(state.fobPairPoll);
      state.fobPairPoll = null;
      return;
    }
    const wasPairing = state.fob?.pairing?.active;
    await loadFobStatus();
    if (!wasPairing) return;
    if (state.fob?.pairing?.active) return;

    clearInterval(state.fobPairPoll);
    state.fobPairPoll = null;
    if (state.fob?.assigned && state.fob?.armed) {
      state.message = {
        kind: "ok",
        text: `Linked ${state.fob.fobName || state.fob.assigned} — armed for 3 hours.`,
      };
    } else {
      state.message = {
        kind: "err",
        text: "Link timed out — tap Link my fob and hold button 4 (green) again.",
      };
    }
    renderHome();
  }, 1500);
}

async function unlinkFob() {
  if (
    !confirm(
      "Unlink this fob from your PIN? It will stop working until you link again.",
    )
  ) {
    return;
  }
  touchActivity();
  const { res, data } = await api("/api/fob/unlink", { method: "POST", body: "{}" });
  if (!res.ok) {
    state.message = { kind: "err", text: data.error || "Could not unlink fob." };
    renderHome();
    return;
  }
  state.message = { kind: "ok", text: data.message || "Fob unlinked." };
  await loadFobStatus();
  renderHome();
}

function fobStatusHtml() {
  const f = state.fob;
  if (f?.canUseFob === false) {
    return `<div class="panel stack" style="margin:0;padding:1rem;border:1px solid var(--border);border-radius:12px">
      <p class="muted" style="margin:0">Fobs need <strong>Evacuation</strong> on your PIN — ask an admin to add it in Staff PINs.</p>
    </div>`;
  }
  if (f?.pairing?.active) {
    const until = f.pairing.expiresAt
      ? new Date(f.pairing.expiresAt).toLocaleTimeString("en-US", {
          timeZone: TZ,
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
    return `
    <div class="panel stack" style="margin:0;padding:1rem;border:2px solid var(--accent);border-radius:12px">
      <div>
        <h2 style="margin:0;font-size:1.05rem">Link your fob</h2>
        <p class="muted" style="margin:0.35rem 0 0"><strong>Hold button 4 (green)</strong> on the fob in your hand until this screen updates. No horns — just links it to you.</p>
      </div>
      <p style="margin:0"><span class="arm-pill arm-pill--on">Waiting until ${escapeHtml(until)} CT</span></p>
    </div>`;
  }
  if (!f?.assigned) {
    return `
    <div class="panel stack" style="margin:0;padding:1rem;border:1px solid var(--border);border-radius:12px">
      <div>
        <h2 style="margin:0;font-size:1.05rem">Campus fob</h2>
        <p class="muted" style="margin:0.35rem 0 0">Link the physical fob in your hand, then carry it for 3 hours per shift.</p>
      </div>
      <button type="button" class="btn btn-primary" id="fob-link">Link my fob</button>
      <p class="muted" style="margin:0;font-size:0.85rem">Then hold <strong>button 4 (green)</strong> to confirm it&apos;s the right one.</p>
    </div>`;
  }
  const armed = f.armed;
  const until = f.expiresAt
    ? new Date(f.expiresAt).toLocaleTimeString("en-US", {
        timeZone: TZ,
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  return `
    <div class="panel stack" style="margin:0;padding:1rem;border:1px solid var(--border);border-radius:12px">
      <div>
        <h2 style="margin:0;font-size:1.05rem">Your fob — ${escapeHtml(f.fobName || f.assigned)}</h2>
        <p class="muted" style="margin:0.35rem 0 0">Arm before carrying the fob. Press works for <strong>3 hours</strong>, then silent until you arm again.</p>
      </div>
      <p style="margin:0">${armed ? `<span class="arm-pill arm-pill--on">Armed until ${escapeHtml(until)} CT</span>` : `<span class="arm-pill arm-pill--off">Not armed — fob presses do nothing</span>`}</p>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        ${armed ? `<button type="button" class="btn btn-ghost" id="fob-disarm">Disarm fob</button>` : `<button type="button" class="btn btn-primary" id="fob-arm">Arm fob (3 hours)</button>`}
        <button type="button" class="btn btn-ghost" id="fob-unlink" style="color:var(--muted)">Unlink fob</button>
      </div>
      <p class="muted" style="margin:0;font-size:0.85rem">Or dial 9090 → press 4 → PIN to re-arm without unlinking.</p>
    </div>`;
}

async function forceLogout(reason) {
  stopLocalPhoneAlarm();
  stopLiveSync();
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
  if (route === "admin") {
    window.location.href = "/desk/";
    return;
  }
  if (route === "home") {
    const solo = singlePanelRoute();
    if (solo) route = solo;
  }
  if (state._speakersTimer && route !== "admin") {
    clearInterval(state._speakersTimer);
    state._speakersTimer = null;
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

/**
 * If the PIN has only one panel role (bells or evacuate), skip Home/logs.
 * Admin always gets Home. `remote` is not a panel.
 */
function singlePanelRoute(scopes = state.session?.scopes) {
  const s = scopes || [];
  if (s.includes("admin")) return null;
  const bells = s.includes("bells");
  const evac = s.includes("evacuate");
  if (bells && !evac) return "bells";
  if (evac && !bells) return "evacuate";
  return null;
}

function routeAfterAuth() {
  if (state.session?.mustChangePin) return "change-pin";
  const solo = singlePanelRoute();
  if (solo) return solo;
  if (
    state.session?.scopes?.includes("admin") &&
    window.matchMedia("(min-width: 1024px)").matches &&
    !sessionStorage.getItem("arnold-alarm-mobile")
  ) {
    window.location.href = "/desk/";
    return "home";
  }
  return "home";
}

function backToHomeLink() {
  if (singlePanelRoute()) return "";
  return `<button type="button" class="back-link" data-go="home">← Home</button>`;
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

/** Apply arm state from Ably/poll without requiring a full page reload. */
function applyArmedState(armed, meta = {}) {
  if (!state.config) state.config = {};
  const next = armed !== false;
  const prev = state.config.armed !== false;
  state.config.armed = next;
  document.querySelectorAll(".brand-row").forEach((row) => {
    const old = row.querySelector(".arm-pill");
    if (!old) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = armBadge();
    old.replaceWith(wrap.firstElementChild);
  });
  if (state.route === "home" && prev !== next) {
    renderHome();
    if (meta.message) {
      state.message = { kind: "ok", text: meta.message };
    }
  } else if (state.route === "admin" && prev !== next) {
    void renderAdmin();
  } else if (meta.by && prev !== next) {
    // Soft notice on other panels
    const row = document.querySelector(".status-row");
    if (row && !row.dataset.armFlash) {
      row.dataset.armFlash = "1";
      const span = row.querySelector("span:last-child");
      const prevText = span?.textContent;
      if (span) {
        span.textContent = next
          ? `Armed by ${meta.by}`
          : `Unarmed by ${meta.by}`;
        setTimeout(() => {
          delete row.dataset.armFlash;
          paintStatusRow();
          if (span && prevText != null) span.textContent = statusCopy()[1];
        }, 2500);
      }
    }
  }
}

/** idle = Red/Blue open, Green locked. red|blue = only All clear open. */
function applyEvacPhase(phase) {
  if (!state.config) state.config = {};
  const next =
    phase === "red" || phase === "blue" || phase === "idle" ? phase : "idle";
  const prev = state.config.evacPhase || "idle";
  state.config.evacPhase = next;
  if (state.route === "evacuate" && prev !== next) {
    renderEvacuate();
  }
}

function evacPhase() {
  return state.config?.evacPhase || "idle";
}

function stopLiveSync() {
  if (systemPollTimer) {
    clearInterval(systemPollTimer);
    systemPollTimer = null;
  }
  try {
    ablyRealtime?.close();
  } catch {
    /* ignore */
  }
  ablyRealtime = null;
}

async function ensureLiveSync() {
  if (!state.session || state.session.mustChangePin) return;

  if (!systemPollTimer) {
    systemPollTimer = setInterval(() => {
      void pollSystemArmed();
    }, 12_000);
  }

  if (ablyRealtime) return;

  try {
    const { res, data } = await api("/api/ably/token");
    if (!res.ok || !data.tokenRequest) return;
    if (data.channel) ablyChannelName = data.channel;

    await loadAblySdk();
    const Ably = window.Ably;
    if (!Ably?.Realtime) return;

    const client = new Ably.Realtime({
      authCallback: (_tokenParams, callback) => {
        api("/api/ably/token")
          .then(({ res: r, data: d }) => {
            if (!r.ok || !d.tokenRequest) {
              callback("token failed", null);
              return;
            }
            callback(null, d.tokenRequest);
          })
          .catch(() => callback("token failed", null));
      },
    });
    ablyRealtime = client;
    const channel = client.channels.get(ablyChannelName);
    channel.subscribe("armed", (msg) => {
      const payload = msg.data || {};
      applyArmedState(payload.armed !== false, {
        by: payload.by,
        message:
          payload.armed === false
            ? `System unarmed${payload.by ? ` by ${payload.by}` : ""}.`
            : `System armed${payload.by ? ` by ${payload.by}` : ""}.`,
      });
      if (state.route === "home") void loadAudit();
    });
    channel.subscribe("evac", (msg) => {
      const payload = msg.data || {};
      if (payload.phase) applyEvacPhase(payload.phase);
      if (state.route === "home") void loadAudit();
    });
    channel.subscribe("activity", () => {
      if (state.route === "home") void loadAudit();
    });
    channel.subscribe("fob-pair", async (msg) => {
      const payload = msg.data || {};
      if (payload.pinId && payload.pinId !== state.session?.pinId) return;
      if (payload.state === "linked") {
        if (state.fobPairPoll) {
          clearInterval(state.fobPairPoll);
          state.fobPairPoll = null;
        }
        state.message = {
          kind: "ok",
          text: `Linked ${payload.fobName || payload.fobId} — armed for 3 hours.`,
        };
        await loadFobStatus();
        if (state.route === "home") renderHome();
      }
    });
  } catch (err) {
    console.warn("[live] Ably unavailable — using poll fallback", err);
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
async function pollSystemArmed() {
  if (!state.session) return;
  try {
    const { res, data } = await api("/api/system");
    if (!res.ok) return;
    if (typeof data.armed === "boolean") {
      applyArmedState(data.armed);
    }
    if (data.evacPhase) applyEvacPhase(data.evacPhase);
  } catch {
    /* ignore */
  }
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
    setRoute(routeAfterAuth());
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
    setRoute(routeAfterAuth());
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
          <h1 class="page-title">${state.session.scopes.includes("admin") ? "Quick access" : "Choose a panel"}</h1>
          <p class="muted" style="margin:0">${
            state.session.scopes.includes("admin")
              ? "Phone app — big emergency buttons. Full management lives on the desktop console."
              : "Access is limited to what your PIN allows."
          }</p>
        </div>
        ${
          !canAdmin && !armed
            ? `<div class="error-banner" style="margin:0">System is <strong>unarmed</strong> — you can still send commands; speakers will not play until an admin arms the system.</div>`
            : ""
        }
        ${canEvac ? fobStatusHtml() : ""}
        <div id="last-play" class="last-play muted">Loading last play…</div>
        <div class="tile-grid">
          ${canEvac ? `<button type="button" class="tile" data-go="evacuate"><h2>Emergency codes</h2><p>Code Red, Blue, and All clear — panic buttons for your phone.</p></button>` : ""}
          ${canBells ? `<button type="button" class="tile" data-go="bells"><h2>Class bells</h2><p>First and second bell — play now or schedule to building time.</p></button>` : ""}
          ${canAdmin ? `<a class="tile" href="/desk/" style="text-decoration:none"><h2>Desktop console</h2><p>Speakers, activity, staff PINs, and system controls — use on a computer.</p></a>` : ""}
        </div>
        <div class="stack" style="gap:0.5rem">
          <p style="margin:0;font-weight:600">Recent activity</p>
          <p class="muted" style="margin:0;font-size:0.85rem">Who activated what, and when (Central).</p>
          <div id="audit-list" class="muted">Loading…</div>
        </div>
        ${banner()}
      </div>
    </main>`;
  $("#fob-link")?.addEventListener("click", () => void startFobPairing());
  $("#fob-arm")?.addEventListener("click", () => void armFob());
  $("#fob-disarm")?.addEventListener("click", () => void disarmFob());
  $("#fob-unlink")?.addEventListener("click", () => void unlinkFob());
  void loadAudit();
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
  applyArmedState(data.armed, {
    message: data.message || (data.armed ? "System armed." : "System unarmed."),
  });
  state.message = { kind: "ok", text: data.message || (data.armed ? "System armed." : "System unarmed.") };
  if (state.route === "admin") void renderAdmin();
  else if (state.route === "home") renderHome();
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
  const lastPlay = events.find((e) => !isSystemStatusEvent(e.actionId));
  if (lastEl) {
    if (!lastPlay) {
      lastEl.className = "last-play muted";
      lastEl.textContent = "No plays yet.";
    } else {
      const e = lastPlay;
      lastEl.className = "last-play";
      lastEl.innerHTML = `
        <p class="last-play-label">Last play</p>
        <p class="last-play-main">${escapeHtml(actionLabel(e.actionId))}</p>
        <p class="last-play-meta">${escapeHtml(e.label)} · ${escapeHtml(formatCentral(e.createdAt))} · ${escapeHtml(eventStatusLabel(e))}</p>`;
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
      const pillClass = eventStatusClass(e);
      const detail = eventDetail(e);
      return `<div class="audit-item${isSystemStatusEvent(e.actionId) ? " audit-item--status" : ""}">
        <div class="when">${escapeHtml(formatCentral(e.createdAt))}</div>
        <p class="who-action">${escapeHtml(e.label)} · ${escapeHtml(actionLabel(e.actionId))}</p>
        ${detail && detail !== "—" ? `<div class="meta">${escapeHtml(detail)}</div>` : ""}
        <span class="status-pill ${pillClass}${e.status === "held" ? " held" : ""}">${escapeHtml(eventStatusLabel(e))}</span>
      </div>`;
    })
    .join("");
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

function eventStatusClass(e) {
  if (isSystemStatusEvent(e.actionId)) {
    return e.actionId === "__system_armed__" ? "ok" : "held";
  }
  if (e.status === "done" || e.status === "queued" || e.status === "scheduled") return "ok";
  if (e.status === "held") return "held";
  return "bad";
}

function eventDetail(e) {
  if (isSystemStatusEvent(e.actionId)) {
    if (e.actionId === "__system_unarmed__") {
      return e.detail || "Plays held until re-armed";
    }
    return "";
  }
  return [e.mode, e.detail].filter(Boolean).join(" · ");
}

function statusPlain(status) {
  if (status === "status") return "status change";
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
  if (actionId.startsWith("test.speaker:")) return "Speaker bell test";
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
    if (data.evacPhase) applyEvacPhase(data.evacPhase);
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
  if (data.evacPhase) applyEvacPhase(data.evacPhase);
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
        : actionId.startsWith("test.speaker:")
          ? 20000
        : actionId === "bells.second"
          ? 30000
          : actionId === "bells.first"
            ? 15000
            : actionId.startsWith("evacuate.")
              ? 20000
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
        ? "Notifying desk phones, then start tone + TEST ACOC on all speakers."
        : actionId.startsWith("test.speaker:")
          ? "Playing Start_Bell_Tone on that speaker at its bell volume."
        : actionId === "bells.second"
          ? "Playing now — start bell tone twice (all speakers)."
          : actionId === "bells.first"
            ? "Playing now — start bell tone on all speakers."
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
    applyEvacPhase(data.evacPhase || "idle");
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
  applyEvacPhase(data.evacPhase || "idle");
  if (!data.token || !data.gatewayUrl) {
    if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not authorize all clear.")}</div>`;
    return;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const clearRes = await fetch(`${data.gatewayUrl}/all-clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: data.token }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const clearData = await clearRes.json().catch(() => ({}));
    if (!clearRes.ok) {
      if (msgEl) msgEl.innerHTML = `<div class="error-banner">${escapeHtml(clearData.error || "All clear failed.")}</div>`;
      return;
    }
    await logAudit("__all_clear__", "lan", "done", "stop + all clear");
    if (msgEl) msgEl.innerHTML = `<div class="success-banner">Playing now — start tone, then All clear (Code Green ×2).</div>`;
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
      ${backToHomeLink()}
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
        <p class="muted" style="margin:0;font-size:0.8rem">First bell = start tone on all speakers. Second bell = same start tone twice on all speakers.</p>
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

/** Local phone alarm during the 10s Red/Blue arming countdown (not campus speakers). */
let localAlarmCtx = null;
let localAlarmNodes = [];
let localAlarmAudio = null;
let evacCountdownTimer = null;

function promoteMediaPlaybackSession() {
  // iOS: Web Audio defaults to ambient (muted by silent switch). "playback" uses media volume.
  try {
    const session = navigator.audioSession;
    if (session && typeof session.type === "string") {
      session.type = "playback";
    }
  } catch {
    /* ignore */
  }
}

/** ~1s looping WAV (HTMLAudioElement) — plays even when iPhone silent switch is on. */
function makeAlarmWavDataUrl(tone = "red") {
  const sampleRate = 22050;
  const seconds = 1;
  const n = sampleRate * seconds;
  const hi = tone === "blue" ? 880 : 980;
  const lo = tone === "blue" ? 620 : 720;
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const beepOn = t % 0.25 < 0.18;
    if (!beepOn) {
      samples[i] = 0;
      continue;
    }
    const freq = Math.floor(t / 0.25) % 2 === 0 ? hi : lo;
    const env = Math.min(1, (t % 0.25) / 0.02) * Math.min(1, (0.18 - (t % 0.25)) / 0.04);
    const v = Math.sin(2 * Math.PI * freq * t) * env * 0.85;
    samples[i] = Math.max(-32767, Math.min(32767, (v * 32767) | 0));
  }
  const dataSize = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function stopLocalPhoneAlarm() {
  if (localAlarmAudio) {
    try {
      localAlarmAudio.pause();
      localAlarmAudio.removeAttribute("src");
      localAlarmAudio.load?.();
    } catch {
      /* ignore */
    }
    localAlarmAudio = null;
  }
  for (const n of localAlarmNodes) {
    try {
      n.stop?.();
      n.disconnect?.();
    } catch {
      /* ignore */
    }
  }
  localAlarmNodes = [];
  if (localAlarmCtx) {
    try {
      localAlarmCtx.close();
    } catch {
      /* ignore */
    }
    localAlarmCtx = null;
  }
  if (evacCountdownTimer) {
    clearInterval(evacCountdownTimer);
    evacCountdownTimer = null;
  }
}

function startWebAudioAlarmFallback(tone = "red") {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  localAlarmCtx = ctx;
  void ctx.resume?.();
  const master = ctx.createGain();
  master.gain.value = 0.28;
  master.connect(ctx.destination);

  const hi = tone === "blue" ? 880 : 980;
  const lo = tone === "blue" ? 620 : 720;
  let t = ctx.currentTime;
  for (let i = 0; i < 40; i++) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = i % 2 === 0 ? hi : lo;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.22);
    localAlarmNodes.push(osc);
    t += 0.25;
  }
}

function startLocalPhoneAlarm(tone = "red") {
  stopLocalPhoneAlarm();
  promoteMediaPlaybackSession();

  // Prefer <audio> (media volume / silent-switch safe on iOS). Must start in the tap gesture.
  try {
    const audio = new Audio(makeAlarmWavDataUrl(tone));
    audio.loop = true;
    audio.playsInline = true;
    audio.setAttribute("playsinline", "true");
    audio.volume = 1;
    localAlarmAudio = audio;
    const playResult = audio.play();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(() => {
        startWebAudioAlarmFallback(tone);
      });
    }
  } catch {
    startWebAudioAlarmFallback(tone);
  }

  try {
    navigator.vibrate?.([220, 80, 220, 80, 220, 80, 220]);
  } catch {
    /* ignore */
  }
}

/**
 * 10s arming countdown: phone alarms locally; Send now / Cancel / auto-fire at 0.
 * Takes over the Emergency page (no scroll) so Send now stays in the thumb zone.
 */
function startEvacArmCountdown({ actionId, label, tone, onFire }) {
  stopLocalPhoneAlarm();
  const TOTAL = 10;
  let remaining = TOTAL;
  let finished = false;
  const shell = $(".evac-shell");
  const box = $("#evac-confirm");
  if (!box) return;

  const paint = () => {
    box.innerHTML = `
      <div class="confirm-box confirm-box--${tone} confirm-safe evac-countdown" role="alertdialog" aria-labelledby="evac-count-heading">
        <div class="evac-countdown-head">
          <p class="evac-countdown-label" id="evac-count-heading">Arming ${escapeHtml(label)}</p>
          <div class="evac-countdown-num" id="evac-count-num" aria-live="polite">${remaining}</div>
          <p class="evac-countdown-hint">Campus silent until send · auto in <strong id="evac-count-sec">${remaining}</strong>s</p>
          <div class="evac-countdown-bar" aria-hidden="true"><span style="transform:scaleX(${(TOTAL - remaining) / TOTAL})"></span></div>
        </div>
        <div class="evac-countdown-actions">
          <button type="button" class="btn btn-code-${tone} btn-block" id="evac-send-now">Send now</button>
          <button type="button" class="btn btn-ghost btn-block" data-cancel-evac>Cancel</button>
        </div>
      </div>`;
  };

  const finish = (send) => {
    if (finished) return;
    finished = true;
    stopLocalPhoneAlarm();
    shell?.classList.remove("is-arming");
    box.innerHTML = "";
    if (send) onFire();
  };

  shell?.classList.add("is-arming");
  paint();
  startLocalPhoneAlarm(tone);

  $("#evac-send-now")?.addEventListener("click", () => finish(true));
  $("[data-cancel-evac]")?.addEventListener("click", () => finish(false));

  evacCountdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      finish(true);
      return;
    }
    const num = $("#evac-count-num");
    const sec = $("#evac-count-sec");
    const bar = box.querySelector(".evac-countdown-bar > span");
    if (num) num.textContent = String(remaining);
    if (sec) sec.textContent = String(remaining);
    if (bar) bar.style.transform = `scaleX(${(TOTAL - remaining) / TOTAL})`;
    try {
      navigator.vibrate?.(remaining <= 3 ? [120] : [60]);
    } catch {
      /* ignore */
    }
  }, 1000);
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
  const phase = evacPhase();
  const codesOpen = phase === "idle";
  const clearOpen = phase === "red" || phase === "blue";
  const phaseHint =
    phase === "red"
      ? "Code Red active — All clear when safe."
      : phase === "blue"
        ? "Code Blue active — All clear when safe."
        : "10s phone alarm before campus speakers.";

  app.innerHTML = `
    <main class="app-shell evac-shell">
      ${header(state.session.label)}
      ${backToHomeLink()}
      <div class="evac-idle">
        <h1 class="page-title evac-title">Emergency</h1>
        <p class="evac-meta">${escapeHtml(phaseHint)}</p>
        <label class="checks evac-loop">
          <input type="checkbox" id="evac-loop" checked /> Loop until all clear
        </label>
      </div>
      <div id="evac-confirm" class="evac-stage"></div>
      <div id="play-msg"></div>
      <div class="evac-thumb-zone">
        <div class="evac-codes">
          ${ordered
            .map((a) => {
              const meta = evacButtonMeta(a);
              const disabled = !codesOpen;
              return `<button type="button" class="btn ${meta.className} btn-block btn-evac" data-arm-evac="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label)}" data-tone="${meta.tone}" ${disabled ? "disabled aria-disabled=\"true\"" : ""}>
                <span>${escapeHtml(meta.title)}</span>
                <span class="btn-evac-sub">${disabled ? "Locked — all clear first" : escapeHtml(meta.short)}</span>
              </button>`;
            })
            .join("")}
        </div>
        <div class="evac-all-clear">
          <button type="button" class="btn btn-code-green btn-block btn-evac" id="evac-all-clear" ${clearOpen ? "" : "disabled aria-disabled=\"true\""}>
            <span>Stop &amp; All clear</span>
            <span class="btn-evac-sub">${clearOpen ? "Hold to confirm" : "Locked until Red or Blue"}</span>
          </button>
        </div>
      </div>
    </main>`;

  stopLocalPhoneAlarm();

  document.querySelectorAll("[data-arm-evac]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled || !codesOpen) return;
      const id = btn.dataset.armEvac;
      const label = btn.dataset.label || id;
      const tone = btn.dataset.tone || evacCodeTone(id);
      startEvacArmCountdown({
        actionId: id,
        label,
        tone,
        onFire: () => {
          const loop = $("#evac-loop")?.checked;
          void playAction(id, $("#play-msg"), 0, loop);
        },
      });
    });
  });

  $("#evac-all-clear")?.addEventListener("click", () => {
    if (!clearOpen) return;
    const shell = $(".evac-shell");
    shell?.classList.add("is-arming");
    $("#evac-confirm").innerHTML = `
      <div class="confirm-box confirm-box--green confirm-safe evac-countdown" role="alertdialog">
        <div class="evac-countdown-head">
          <p class="evac-countdown-label">All clear</p>
          <p class="evac-countdown-hint">Start tone + Code Green ×2. Ends the active code.</p>
        </div>
        <div class="evac-countdown-actions">
          <button type="button" class="btn btn-code-green btn-block btn-hold" id="confirm-all-clear" aria-label="Hold to confirm all clear">
            <span class="btn-hold-fill"></span>
            <span class="btn-hold-label">Hold to confirm</span>
          </button>
          <button type="button" class="btn btn-ghost btn-block" data-cancel-evac>Cancel</button>
        </div>
      </div>`;
    wireHoldConfirm($("#confirm-all-clear"), () => {
      shell?.classList.remove("is-arming");
      $("#evac-confirm").innerHTML = "";
      void stopAndAllClear($("#play-msg"));
    });
    $("[data-cancel-evac]")?.addEventListener("click", () => {
      shell?.classList.remove("is-arming");
      $("#evac-confirm").innerHTML = "";
    });
  });
}

function speakerStatusHtml(data) {
  const speakers = data.speakers || [];
  const volumes = data.volumes || {};
  const bySpeaker = volumes.bellsBySpeaker || {};
  const defaultBell = Number(volumes.bells ?? 60);
  if (!speakers.length) {
    return `<p class="muted" style="margin:0">No speaker report yet — gateway will publish within a few seconds when online.</p>`;
  }
  return `<ul class="speaker-list">${speakers
    .map((s) => {
      const ok = String(s.state || "").toUpperCase() === "CONNECTED";
      const activity = s.speakerStatus || "—";
      const bellVol =
        typeof bySpeaker[s.id] === "number" ? bySpeaker[s.id] : defaultBell;
      return `<li class="speaker-row">
        <span class="speaker-dot ${ok ? "speaker-dot--ok" : "speaker-dot--bad"}" title="${escapeHtml(s.state || "")}"></span>
        <div class="speaker-main">
          <div class="speaker-head">
            <span class="speaker-name">${escapeHtml(s.name)}</span>
            <button type="button" class="btn btn-ghost speaker-test-btn" data-test-speaker="${escapeHtml(s.id)}" data-test-name="${escapeHtml(s.name)}" ${ok ? "" : "disabled"}>Test bell</button>
          </div>
          <span class="muted speaker-meta">${escapeHtml(String(s.state || "UNKNOWN"))} · now ${Number(s.volume) || 0}% · ${escapeHtml(activity)}</span>
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

async function refreshAdminSpeakers() {
  const list = $("#speakers-list");
  const meta = $("#speakers-meta");
  if (!list) return;
  const editing = document.activeElement?.matches?.("[data-bell-speaker], #bell-vol, #evac-vol");
  const { res, data } = await api("/api/admin/speakers");
  if (!res.ok) {
    list.innerHTML = `<p class="error-banner" style="margin:0">${escapeHtml(data.error || "Could not load speakers.")}</p>`;
    return;
  }
  if (!editing) {
    list.innerHTML = speakerStatusHtml(data);
    list.querySelectorAll("[data-bell-speaker]").forEach((input) => {
      input.addEventListener("input", () => {
        const label = input.closest("label")?.querySelector(".bell-vol-val");
        if (label) label.textContent = `${input.value}%`;
      });
    });
    list.querySelectorAll("[data-test-speaker]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.testSpeaker;
        if (!id) return;
        const msg = list.querySelector(`[data-test-msg="${CSS.escape(id)}"]`);
        void playAction(`test.speaker:${id}`, msg || $("#admin-test-msg"));
      });
    });
  }
  const gw = data.gateway?.online
    ? "Gateway online"
    : data.gateway?.ageSec != null
      ? `Gateway last seen ${data.gateway.ageSec}s ago`
      : "Gateway offline";
  const age =
    data.ageSec == null
      ? "waiting for first report"
      : data.ageSec < 15
        ? "just updated"
        : `updated ${data.ageSec}s ago`;
  if (meta) meta.textContent = `${gw} · ${age}`;

  const bell = $("#bell-vol");
  const evac = $("#evac-vol");
  if (bell && data.volumes && document.activeElement !== bell) {
    bell.value = String(data.volumes.bells);
    const lbl = $("#bell-vol-label");
    if (lbl) lbl.textContent = `${data.volumes.bells}%`;
  }
  if (evac && data.volumes && document.activeElement !== evac) {
    evac.value = String(data.volumes.evac);
    const lbl = $("#evac-vol-label");
    if (lbl) lbl.textContent = `${data.volumes.evac}%`;
  }
}

function wireAdminSpeakers() {
  const syncLabels = () => {
    const bell = $("#bell-vol");
    const evac = $("#evac-vol");
    const bl = $("#bell-vol-label");
    const el = $("#evac-vol-label");
    if (bell && bl) bl.textContent = `${bell.value}%`;
    if (evac && el) el.textContent = `${evac.value}%`;
  };
  $("#bell-vol")?.addEventListener("input", syncLabels);
  $("#evac-vol")?.addEventListener("input", syncLabels);
  $("#refresh-speakers")?.addEventListener("click", () => void refreshAdminSpeakers());
  $("#save-volumes")?.addEventListener("click", async () => {
    const msg = $("#volume-msg");
    const bells = Number($("#bell-vol")?.value || 60);
    const evac = Number($("#evac-vol")?.value || 100);
    const bellsBySpeaker = {};
    document.querySelectorAll("[data-bell-speaker]").forEach((input) => {
      const id = input.dataset.bellSpeaker;
      if (id) bellsBySpeaker[id] = Number(input.value);
    });
    if (msg) msg.innerHTML = `<p class="muted" style="margin:0">Saving…</p>`;
    const { res, data } = await api("/api/admin/volumes", {
      method: "POST",
      body: JSON.stringify({ bells, evac, bellsBySpeaker }),
    });
    if (!res.ok) {
      if (msg)
        msg.innerHTML = `<div class="error-banner">${escapeHtml(data.error || "Could not save.")}</div>`;
      return;
    }
    if (msg)
      msg.innerHTML = `<div class="success-banner">${escapeHtml(data.message || "Saved.")}</div>`;
  });
  void refreshAdminSpeakers();
  if (state._speakersTimer) clearInterval(state._speakersTimer);
  state._speakersTimer = setInterval(() => {
    if (state.route === "admin") void refreshAdminSpeakers();
  }, 10_000);
}

async function renderAdmin() {
  const { res, data } = await api("/api/admin/pins");
  const pins = res.ok ? data.pins || [] : [];
  const armed = state.config?.armed !== false;
  if (state._speakersTimer) {
    clearInterval(state._speakersTimer);
    state._speakersTimer = null;
  }
  app.innerHTML = `
    <main class="app-shell">
      ${header(state.session.label)}
      ${backToHomeLink()}
      <div class="stack">
        <div>
          <h1 class="page-title">Admin</h1>
          <p class="muted" style="margin:0">Arm the system, run speaker check, and manage staff PINs.</p>
        </div>
        <div class="card stack arm-card" style="gap:0.65rem;padding:1rem 1.1rem">
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
        </div>
        <div class="card stack" style="gap:0.65rem;padding:1rem 1.1rem">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap">
            <div>
              <p style="margin:0;font-weight:600">Campus speakers</p>
              <p class="muted" style="margin:0.25rem 0 0;font-size:0.85rem" id="speakers-meta">Loading status…</p>
            </div>
            <button type="button" class="btn btn-ghost" id="refresh-speakers" style="min-height:2.5rem;padding:0.4rem 1rem">Refresh</button>
          </div>
          <div id="speakers-list" class="muted" style="font-size:0.9rem">…</div>
          <div class="stack" style="gap:0.55rem;border-top:1px solid color-mix(in oklab, CanvasText 12%, transparent);padding-top:0.75rem">
            <p style="margin:0;font-weight:600">Volume profiles</p>
            <p class="muted" style="margin:0;font-size:0.85rem">
              Set <strong>Bell</strong> under each speaker above. Emergency / PA stays full on every horn.
              Speakers restore to emergency level after each bell.
            </p>
            <label class="field" style="margin:0">
              <span style="display:flex;justify-content:space-between;gap:0.5rem">
                <span>Default bell (new speakers)</span>
                <strong id="bell-vol-label">60%</strong>
              </span>
              <input type="range" id="bell-vol" min="20" max="100" step="5" value="60" />
            </label>
            <label class="field" style="margin:0">
              <span style="display:flex;justify-content:space-between;gap:0.5rem">
                <span>Emergency / PA</span>
                <strong id="evac-vol-label">100%</strong>
              </span>
              <input type="range" id="evac-vol" min="50" max="100" step="5" value="100" />
            </label>
            <button type="button" class="btn btn-primary" id="save-volumes" style="min-height:2.5rem">Save volumes</button>
            <div id="volume-msg"></div>
          </div>
        </div>
        <div class="card stack" style="gap:0.55rem;padding:1rem 1.1rem">
          <p style="margin:0;font-weight:600">Speaker check</p>
          <p class="muted" style="margin:0;font-size:0.85rem">Rings desk phones with a stand-by warning, then start tone + <strong>TEST ACOC</strong> on every campus speaker.</p>
          <button type="button" class="btn btn-ghost btn-block" id="admin-test-speakers" style="min-height:2.5rem">Speaker check — notify desks, then all speakers</button>
          <div id="admin-test-msg"></div>
        </div>
        <div>
          <h2 class="page-title" style="font-size:1.15rem;margin:0.5rem 0 0.35rem">Staff PINs</h2>
          <p class="muted" style="margin:0">Hashed in Cloudflare D1. Grant <strong>Remote play</strong> only to trusted staff. Sessions end after 45 minutes (30 min idle).</p>
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
        ${banner()}
      </div>
    </main>`;

  $("#toggle-armed")?.addEventListener("click", () => void toggleArmed());
  $("#admin-test-speakers")?.addEventListener("click", () => {
    void playAction("test.speakers", $("#admin-test-msg"));
  });
  wireAdminSpeakers();

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
  // Safety net: never show Home chooser/logs for single-role PINs.
  if (state.route === "home") {
    const solo = singlePanelRoute();
    if (solo) {
      state.route = solo;
    }
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
    state.route = routeAfterAuth();
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
