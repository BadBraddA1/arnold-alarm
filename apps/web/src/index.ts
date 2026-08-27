import { publishSystemEvent, createSystemTokenRequest } from "./ably";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import bcrypt from "bcryptjs";
import { signPlayToken, signSession, verifySession } from "./auth";
import {
  cancelScheduledPlay,
  checkRateLimit,
  claimPendingJobs,
  clearRateLimit,
  enqueuePlay,
  finishJob,
  insertAudit,
  insertPin,
  listActivePins,
  listAllPins,
  listAudit,
  listScheduledPlays,
  getPinById,
  setPinActive,
  setPinHash,
  touchGatewayHeartbeat,
  getGatewayHeartbeat,
  getSystemArmed,
  setSystemArmed,
  updateAuditStatus,
  updatePinScopes,
} from "./db";
import {
  actionAllowed,
  hasScope,
  normalizeScopes,
  parseActionList,
  resolvePlayLoop,
  SESSION_COOKIE,
  SESSION_IDLE_SEC,
  SESSION_MAX_AGE_SEC,
  type Env,
  type Scope,
} from "./types";

type Variables = {
  session: Awaited<ReturnType<typeof verifySession>>;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function clientIp(c: { req: { header: (n: string) => string | undefined } }) {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function parseScopesField(raw: string): Scope[] {
  try {
    const parsed = JSON.parse(raw) as string[];
    return normalizeScopes(parsed);
  } catch {
    return normalizeScopes(raw.split(",").map((s) => s.trim()));
  }
}

function randomTempPin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, "0");
}

const UNARMED_MSG =
  "System is unarmed — command recorded, speakers will not play until an admin arms the system.";

async function holdUnarmedPlay(
  env: Env,
  session: NonNullable<Variables["session"]>,
  actionId: string,
  mode: string,
  detail?: string,
) {
  const id = crypto.randomUUID();
  await insertAudit(env, {
    id,
    actionId,
    label: session.label,
    pinId: session.pinId,
    mode,
    status: "held",
    detail: detail ? `${detail} · unarmed` : "unarmed — not played",
  });
  await publishSystemEvent(env, "activity", {
    id,
    actionId,
    status: "held",
    at: Date.now(),
  });
  return {
    ok: true,
    armed: false,
    held: true,
    played: false,
    id,
    message: UNARMED_MSG,
  };
}

function gatewayAuthorized(c: {
  req: { header: (n: string) => string | undefined };
  env: Env;
}) {
  const secret = c.env.GATEWAY_POLL_SECRET;
  if (!secret) return false;
  const auth = c.req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === secret;
}

app.use("*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await verifySession(c.env, token) : null;
  c.set("session", session);
  await next();
});

app.get("/api/config", async (c) => {
  const evacuateActions = parseActionList(c.env.EVACUATE_ACTIONS);
  const armed = await getSystemArmed(c.env);
  return c.json({
    gatewayUrl: c.env.GATEWAY_URL,
    armed,
    bellActions: parseActionList(c.env.BELL_ACTIONS),
    evacuateActions:
      evacuateActions.length > 0
        ? evacuateActions.filter((a) => a.id !== "evacuate.code_green")
        : [
            { id: "evacuate.code_red", label: "Code Red — Evacuate" },
            { id: "evacuate.code_blue", label: "Code Blue — Lockdown" },
          ],
  });
});

/** Public arm status for gateway SIP PA (no secrets). */
app.get("/api/system", async (c) => {
  const armed = await getSystemArmed(c.env);
  return c.json({ armed });
});

/** Ably TokenRequest for signed-in staff — subscribe to live arm/activity. */
app.get("/api/ably/token", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (!c.env.ABLY_API_KEY) {
    return c.json({ error: "Live sync not configured." }, 503);
  }
  try {
    const tokenRequest = await createSystemTokenRequest(
      c.env,
      `pin:${session.pinId}`,
    );
    return c.json({ tokenRequest, channel: "arnold-alarm:system" });
  } catch (err) {
    console.error("[ably/token]", err);
    return c.json({ error: "Could not create live token." }, 500);
  }
});

app.get("/api/auth/session", (c) => {
  const session = c.get("session");
  if (!session) return c.json({ authenticated: false }, 401);
  return c.json({
    authenticated: true,
    label: session.label,
    scopes: session.scopes,
    mustChangePin: !!session.mustChangePin,
    expiresAt: session.expiresAt,
    idleSec: SESSION_IDLE_SEC,
    maxAgeSec: SESSION_MAX_AGE_SEC,
  });
});

app.post("/api/auth/pin", async (c) => {
  if (!c.env.SESSION_SECRET || !c.env.PLAY_JWT_SECRET) {
    return c.json({ error: "Server secrets not configured." }, 500);
  }
  const body = (await c.req.json().catch(() => ({}))) as { pin?: string };
  const pin = (body.pin ?? "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(pin)) {
    return c.json({ error: "Enter a 6-digit PIN." }, 400);
  }

  const ip = clientIp(c);
  const limit = await checkRateLimit(c.env, ip);
  if (!limit.allowed) {
    return c.json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  }

  const pins = await listActivePins(c.env);
  let matched: (typeof pins)[0] | null = null;
  for (const row of pins) {
    if (await bcrypt.compare(pin, row.pin_hash)) {
      matched = row;
      break;
    }
  }
  if (!matched) return c.json({ error: "Incorrect PIN." }, 401);

  await clearRateLimit(c.env, ip);
  const scopes = parseScopesField(matched.scopes);
  const mustChangePin = !!matched.must_change_pin;
  const token = await signSession(c.env, {
    pinId: matched.id,
    label: matched.label,
    scopes,
    mustChangePin,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
  return c.json({
    ok: true,
    label: matched.label,
    scopes,
    mustChangePin,
    expiresAt: Date.now() + SESSION_MAX_AGE_SEC * 1000,
    idleSec: SESSION_IDLE_SEC,
    maxAgeSec: SESSION_MAX_AGE_SEC,
  });
});

app.post("/api/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.post("/api/auth/change-pin", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    pin?: string;
    confirm?: string;
  };
  const pin = (body.pin ?? "").replace(/\D/g, "");
  const confirm = (body.confirm ?? "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(pin)) {
    return c.json({ error: "Enter a new 6-digit PIN." }, 400);
  }
  if (pin !== confirm) {
    return c.json({ error: "PINs do not match." }, 400);
  }

  const row = await getPinById(c.env, session.pinId);
  if (!row || !row.active) {
    return c.json({ error: "PIN account not found." }, 404);
  }
  if (await bcrypt.compare(pin, row.pin_hash)) {
    return c.json(
      { error: "Choose a new PIN — it cannot be the same as the temporary one." },
      400,
    );
  }

  const pinHash = await bcrypt.hash(pin, 10);
  await setPinHash(c.env, session.pinId, pinHash, false);

  const scopes = parseScopesField(row.scopes);
  const token = await signSession(c.env, {
    pinId: session.pinId,
    label: row.label,
    scopes,
    mustChangePin: false,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
  return c.json({
    ok: true,
    label: row.label,
    scopes,
    mustChangePin: false,
    expiresAt: Date.now() + SESSION_MAX_AGE_SEC * 1000,
    idleSec: SESSION_IDLE_SEC,
    maxAgeSec: SESSION_MAX_AGE_SEC,
  });
});
app.post("/api/play-token", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { actionId?: string };
  const actionId = body.actionId?.trim();
  if (!actionId) return c.json({ error: "actionId required" }, 400);
  if (!actionAllowed(actionId, session.scopes)) {
    return c.json({ error: "Not allowed for this PIN." }, 403);
  }

  if (!(await getSystemArmed(c.env))) {
    return c.json(await holdUnarmedPlay(c.env, session, actionId, "lan"));
  }

  const token = await signPlayToken(c.env, {
    pinId: session.pinId,
    scopes: session.scopes,
    actionId,
  });
  return c.json({
    token,
    gatewayUrl: c.env.GATEWAY_URL,
    expiresInSec: 60,
    canRemote: hasScope(session.scopes, "remote"),
    armed: true,
  });
});

app.post("/api/play-remote", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  if (!hasScope(session.scopes, "remote")) {
    return c.json(
      {
        error:
          "This PIN cannot play off campus. Join church Wi‑Fi or ask an admin for remote access.",
      },
      403,
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    actionId?: string;
    delayMinutes?: number;
    loop?: boolean;
  };
  const actionId = body.actionId?.trim();
  if (!actionId) return c.json({ error: "actionId required" }, 400);
  if (!actionAllowed(actionId, session.scopes)) {
    return c.json({ error: "Not allowed for this PIN." }, 403);
  }
  const delayMinutes = Math.max(0, Math.min(720, Number(body.delayMinutes) || 0));
  const loop = resolvePlayLoop(
    actionId,
    typeof body.loop === "boolean" ? body.loop : undefined,
  );

  if (!(await getSystemArmed(c.env))) {
    return c.json(
      await holdUnarmedPlay(
        c.env,
        session,
        actionId,
        "remote",
        [
          delayMinutes > 0 ? `delay ${delayMinutes}m` : null,
          loop ? "loop" : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      ),
    );
  }

  const id = crypto.randomUUID();
  const fireAt =
    delayMinutes > 0
      ? new Date(Date.now() + delayMinutes * 60_000).toISOString()
      : null;
  await enqueuePlay(c.env, {
    id,
    actionId,
    pinId: session.pinId,
    label: session.label,
    delayMinutes,
    loop,
    fireAt,
  });
  await insertAudit(c.env, {
    id,
    actionId,
    label: session.label,
    pinId: session.pinId,
    mode: "remote",
    status: delayMinutes > 0 ? "scheduled" : "queued",
    detail: [
      delayMinutes > 0 ? `delay ${delayMinutes}m` : null,
      fireAt ? `fire ${fireAt}` : null,
      loop ? "loop" : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined,
  });
  await publishSystemEvent(c.env, "activity", {
    id,
    actionId,
    status: delayMinutes > 0 ? "scheduled" : "queued",
    at: Date.now(),
  });
  return c.json({
    ok: true,
    id,
    mode: "remote",
    armed: true,
    status: delayMinutes > 0 ? "scheduled" : "queued",
    fireAt,
    message:
      delayMinutes > 0
        ? `Scheduled on campus — not playing yet. Will ring in about ${delayMinutes} min (void anytime before then).`
        : "Queued on campus — not playing yet. Gateway usually picks this up within a few seconds.",
  });
});

app.get("/api/schedule", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const jobs = await listScheduledPlays(c.env);
  return c.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      actionId: j.action_id,
      label: j.label,
      fireAt: j.fire_at,
      delayMinutes: j.delay_minutes,
      source: "cloud" as const,
    })),
  });
});

app.delete("/api/schedule/:id", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  const id = c.req.param("id")?.trim();
  if (!id) return c.json({ error: "id required" }, 400);
  const ok = await cancelScheduledPlay(c.env, id);
  if (!ok) {
    return c.json({ error: "Not found or already fired." }, 404);
  }
  await insertAudit(c.env, {
    id: crypto.randomUUID(),
    actionId: "__void_schedule__",
    label: session.label,
    pinId: session.pinId,
    mode: "remote",
    status: "voided",
    detail: `void ${id}`,
  });
  return c.json({ ok: true });
});

app.post("/api/stop-remote", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  if (!hasScope(session.scopes, "remote")) {
    return c.json({ error: "Remote all clear requires remote play access." }, 403);
  }
  if (!actionAllowed("__all_clear__", session.scopes)) {
    return c.json({ error: "Not allowed to issue all clear." }, 403);
  }

  if (!(await getSystemArmed(c.env))) {
    return c.json(
      await holdUnarmedPlay(c.env, session, "__all_clear__", "remote", "stop + all clear"),
    );
  }

  const id = crypto.randomUUID();
  await enqueuePlay(c.env, {
    id,
    actionId: "__all_clear__",
    pinId: session.pinId,
    label: session.label,
    delayMinutes: 0,
    command: "all_clear",
  });
  await insertAudit(c.env, {
    id,
    actionId: "__all_clear__",
    label: session.label,
    pinId: session.pinId,
    mode: "remote",
    status: "queued",
    detail: "stop + all clear",
  });
  await publishSystemEvent(c.env, "activity", {
    id,
    actionId: "__all_clear__",
    status: "queued",
    at: Date.now(),
  });
  return c.json({
    ok: true,
    status: "queued",
    message:
      "All clear queued on campus — not playing yet. Code Green ×2 starts when the gateway picks it up.",
  });
});

const IVR_ALARM_ACTIONS = new Set([
  "evacuate.code_red",
  "evacuate.code_blue",
  "__all_clear__",
]);

/**
 * Gateway-only: verify staff PIN from phone IVR and authorize a local alarm play.
 * Does not enqueue — the Pi plays immediately after a successful response.
 */
app.post("/api/gateway/ivr-alarm", async (c) => {
  if (!gatewayAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    pin?: string;
    actionId?: string;
  };
  const pin = (body.pin ?? "").replace(/\D/g, "");
  const actionId = (body.actionId ?? "").trim();
  if (!/^\d{6}$/.test(pin)) {
    return c.json({ error: "invalid_pin", message: "Enter a 6-digit PIN." }, 400);
  }
  if (!IVR_ALARM_ACTIONS.has(actionId)) {
    return c.json({ error: "invalid_action", message: "Unsupported alarm action." }, 400);
  }

  const limit = await checkRateLimit(c.env, `ivr:${clientIp(c)}`);
  if (!limit.allowed) {
    return c.json(
      { error: "rate_limited", message: "Too many attempts. Try again later." },
      429,
    );
  }

  const pins = await listActivePins(c.env);
  let matched: (typeof pins)[0] | null = null;
  for (const row of pins) {
    if (await bcrypt.compare(pin, row.pin_hash)) {
      matched = row;
      break;
    }
  }
  if (!matched) {
    return c.json({ error: "incorrect_pin", message: "Incorrect PIN." }, 401);
  }
  if (matched.must_change_pin) {
    return c.json(
      { error: "must_change_pin", message: "Change your temporary PIN in the app first." },
      403,
    );
  }

  await clearRateLimit(c.env, `ivr:${clientIp(c)}`);
  const scopes = parseScopesField(matched.scopes);
  if (!actionAllowed(actionId, scopes)) {
    return c.json(
      { error: "not_allowed", message: "Not allowed for this PIN." },
      403,
    );
  }

  const armed = await getSystemArmed(c.env);
  const id = crypto.randomUUID();
  if (!armed) {
    await insertAudit(c.env, {
      id,
      actionId,
      label: matched.label,
      pinId: matched.id,
      mode: "ivr",
      status: "held",
      detail: "phone IVR · unarmed — not played",
    });
    return c.json({
      ok: true,
      armed: false,
      held: true,
      id,
      actionId,
      label: matched.label,
      message: UNARMED_MSG,
    });
  }

  await insertAudit(c.env, {
    id,
    actionId,
    label: matched.label,
    pinId: matched.id,
    mode: "ivr",
    status: "done",
    detail: "phone IVR — playing on campus",
  });
  return c.json({
    ok: true,
    armed: true,
    held: false,
    id,
    actionId,
    label: matched.label,
    playLocal: true,
  });
});

app.get("/api/gateway/status", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const row = await getGatewayHeartbeat(c.env);
  if (!row?.last_seen) {
    return c.json({
      seen: false,
      online: false,
      ageSec: null,
      message: "Campus gateway has not checked in yet.",
    });
  }
  const seenMs = Date.parse(
    row.last_seen.includes("T") || row.last_seen.includes("Z")
      ? row.last_seen
      : `${row.last_seen}Z`,
  );
  const ageSec = Number.isFinite(seenMs)
    ? Math.max(0, Math.round((Date.now() - seenMs) / 1000))
    : null;
  const online = ageSec != null && ageSec < 45;
  return c.json({
    seen: true,
    online,
    ageSec,
    lastSeen: row.last_seen,
    message: online
      ? "Campus gateway online (remote path)."
      : ageSec != null
        ? `Campus gateway last seen ${ageSec}s ago — queued plays may wait.`
        : "Campus gateway status unknown.",
  });
});

app.get("/api/gateway/poll", async (c) => {
  if (!gatewayAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
  await touchGatewayHeartbeat(c.env, "poll");
  const jobs = await claimPendingJobs(c.env, 5);
  return c.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      actionId: j.action_id,
      // Scheduled jobs are only claimed when due — play immediately on the Pi.
      delayMinutes: j.status === "scheduled" ? 0 : j.delay_minutes,
      label: j.label,
      createdAt: j.created_at,
      loop: Boolean(j.loop_play),
      command: j.command ?? "play",
    })),
  });
});

app.post("/api/gateway/ack", async (c) => {
  if (!gatewayAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
  await touchGatewayHeartbeat(c.env, "ack");
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: string;
    ok?: boolean;
    error?: string;
  };
  if (!body.id || typeof body.ok !== "boolean") {
    return c.json({ error: "id and ok required" }, 400);
  }
  await finishJob(c.env, body.id, body.ok, body.error);
  await updateAuditStatus(
    c.env,
    body.id,
    body.ok ? "done" : "error",
    body.error,
  );
  return c.json({ ok: true });
});

app.get("/api/audit", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const rows = await listAudit(c.env, 75);
  return c.json({
    events: rows.map((r) => ({
      id: r.id,
      actionId: r.action_id,
      label: r.label,
      mode: r.mode,
      status: r.status,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  });
});

app.post("/api/audit", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    actionId?: string;
    mode?: string;
    status?: string;
    detail?: string;
  };
  const actionId = body.actionId?.trim();
  if (!actionId) return c.json({ error: "actionId required" }, 400);
  if (!actionAllowed(actionId, session.scopes)) {
    return c.json({ error: "Not allowed for this PIN." }, 403);
  }
  const id = crypto.randomUUID();
  await insertAudit(c.env, {
    id,
    actionId,
    label: session.label,
    pinId: session.pinId,
    mode: body.mode === "remote" ? "remote" : "lan",
    status: body.status || "done",
    detail: body.detail,
  });
  await publishSystemEvent(c.env, "activity", {
    id,
    actionId,
    status: body.status || "done",
    at: Date.now(),
  });
  return c.json({ ok: true, id });
});

app.get("/api/admin/pins", async (c) => {
  const session = c.get("session");
  if (!session?.scopes.includes("admin")) return c.json({ error: "Forbidden" }, 403);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  const rows = await listAllPins(c.env);
  return c.json({
    pins: rows.map((p) => ({
      id: p.id,
      label: p.label,
      scopes: parseScopesField(p.scopes),
      active: !!p.active,
      mustChangePin: !!p.must_change_pin,
      created_at: p.created_at,
    })),
  });
});

app.post("/api/admin/pins", async (c) => {
  const session = c.get("session");
  if (!session?.scopes.includes("admin")) return c.json({ error: "Forbidden" }, 403);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: string;
    pin?: string;
    scopes?: string[];
    temp?: boolean;
  };
  const label = (body.label ?? "").trim();
  const temp = !!body.temp;
  let pin = (body.pin ?? "").replace(/\D/g, "");
  if (!label) return c.json({ error: "label required" }, 400);
  if (temp && !pin) pin = randomTempPin();
  if (!/^\d{6}$/.test(pin)) {
    return c.json({ error: "label and 6-digit pin required" }, 400);
  }
  const scopes = normalizeScopes(body.scopes ?? ["bells"]);
  if (!scopes.filter((s) => s !== "remote").length) {
    return c.json({ error: "at least one of bells/evacuate/admin required" }, 400);
  }
  const id = crypto.randomUUID();
  const pinHash = await bcrypt.hash(pin, 10);
  await insertPin(c.env, {
    id,
    label,
    pinHash,
    scopes,
    mustChangePin: temp,
  });
  return c.json({
    ok: true,
    id,
    label,
    scopes,
    mustChangePin: temp,
    /** Only returned once — for handing the temp PIN to the person. */
    tempPin: temp ? pin : undefined,
  });
});

app.patch("/api/admin/pins", async (c) => {
  const session = c.get("session");
  if (!session?.scopes.includes("admin")) return c.json({ error: "Forbidden" }, 403);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: string;
    active?: boolean;
    scopes?: string[];
  };
  if (!body.id) return c.json({ error: "id required" }, 400);

  if (Array.isArray(body.scopes)) {
    const scopes = normalizeScopes(body.scopes);
    if (!scopes.filter((s) => s !== "remote").length) {
      return c.json({ error: "at least one of bells/evacuate/admin required" }, 400);
    }
    await updatePinScopes(c.env, body.id, scopes);
  }
  if (typeof body.active === "boolean") {
    await setPinActive(c.env, body.id, body.active);
  }
  return c.json({ ok: true });
});

/** Admin only — arm/disarm speakers. Staff can still send commands while unarmed; they are held. */
app.post("/api/admin/armed", async (c) => {
  const session = c.get("session");
  if (!session?.scopes.includes("admin")) return c.json({ error: "Forbidden" }, 403);
  if (session.mustChangePin) {
    return c.json({ error: "Set your permanent PIN before using the alarm." }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { armed?: boolean };
  if (typeof body.armed !== "boolean") {
    return c.json({ error: "armed (boolean) required" }, 400);
  }
  await setSystemArmed(c.env, body.armed);
  const auditId = crypto.randomUUID();
  await insertAudit(c.env, {
    id: auditId,
    actionId: body.armed ? "__system_armed__" : "__system_unarmed__",
    label: session.label,
    pinId: session.pinId,
    mode: "admin",
    status: "done",
    detail: body.armed ? "system armed" : "system unarmed — plays held",
  });
  await publishSystemEvent(c.env, "armed", {
    armed: body.armed,
    by: session.label,
    at: Date.now(),
  });
  await publishSystemEvent(c.env, "activity", {
    id: auditId,
    actionId: body.armed ? "__system_armed__" : "__system_unarmed__",
    status: "done",
    at: Date.now(),
  });
  return c.json({
    ok: true,
    armed: body.armed,
    message: body.armed
      ? "System armed — speakers will play commands."
      : "System unarmed — commands are recorded but speakers stay silent.",
  });
});

app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
