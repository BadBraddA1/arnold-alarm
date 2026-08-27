import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import bcrypt from "bcryptjs";
import { signPlayToken, signSession, verifySession } from "./auth";
import {
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
  setPinActive,
  updateAuditStatus,
  updatePinScopes,
} from "./db";
import {
  actionAllowed,
  hasScope,
  normalizeScopes,
  parseActionList,
  SESSION_COOKIE,
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

app.get("/api/config", (c) => {
  const evacuateActions = parseActionList(c.env.EVACUATE_ACTIONS);
  return c.json({
    gatewayUrl: c.env.GATEWAY_URL,
    bellActions: parseActionList(c.env.BELL_ACTIONS),
    evacuateActions:
      evacuateActions.length > 0
        ? evacuateActions
        : [
            { id: "evacuate.code_red", label: "Code Red — Evacuate" },
            { id: "evacuate.code_blue", label: "Code Blue — Lockdown" },
            { id: "evacuate.code_green", label: "Code Green — All clear" },
          ],
  });
});

app.get("/api/auth/session", (c) => {
  const session = c.get("session");
  if (!session) return c.json({ authenticated: false }, 401);
  return c.json({
    authenticated: true,
    label: session.label,
    scopes: session.scopes,
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
  const token = await signSession(c.env, {
    pinId: matched.id,
    label: matched.label,
    scopes,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
  return c.json({ ok: true, label: matched.label, scopes });
});

app.post("/api/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.post("/api/play-token", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { actionId?: string };
  const actionId = body.actionId?.trim();
  if (!actionId) return c.json({ error: "actionId required" }, 400);
  if (!actionAllowed(actionId, session.scopes)) {
    return c.json({ error: "Not allowed for this PIN." }, 403);
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
  });
});

app.post("/api/play-remote", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
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
  const delayMinutes = Math.max(0, Math.min(120, Number(body.delayMinutes) || 0));
  const loop = Boolean(body.loop);

  const id = crypto.randomUUID();
  await enqueuePlay(c.env, {
    id,
    actionId,
    pinId: session.pinId,
    label: session.label,
    delayMinutes,
    loop,
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
      loop ? "loop" : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined,
  });
  return c.json({
    ok: true,
    id,
    mode: "remote",
    message:
      delayMinutes > 0
        ? `Queued on campus gateway — will play in ${delayMinutes} min.`
        : "Queued on campus gateway — playing shortly.",
  });
});

app.post("/api/stop-remote", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (!hasScope(session.scopes, "remote")) {
    return c.json({ error: "Remote stop requires remote play access." }, 403);
  }
  if (!hasScope(session.scopes, "evacuate") && !hasScope(session.scopes, "admin")) {
    return c.json({ error: "Not allowed to stop emergency audio." }, 403);
  }

  const id = crypto.randomUUID();
  await enqueuePlay(c.env, {
    id,
    actionId: "__stop__",
    pinId: session.pinId,
    label: session.label,
    delayMinutes: 0,
    command: "stop",
  });
  await insertAudit(c.env, {
    id,
    actionId: "__stop__",
    label: session.label,
    pinId: session.pinId,
    mode: "remote",
    status: "queued",
    detail: "stop",
  });
  return c.json({
    ok: true,
    message: "Stop queued — speakers should go silent within a few seconds.",
  });
});

app.get("/api/gateway/poll", async (c) => {
  if (!gatewayAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
  const jobs = await claimPendingJobs(c.env, 5);
  return c.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      actionId: j.action_id,
      delayMinutes: j.delay_minutes,
      label: j.label,
      createdAt: j.created_at,
      loop: Boolean(j.loop_play),
      command: j.command ?? "play",
    })),
  });
});

app.post("/api/gateway/ack", async (c) => {
  if (!gatewayAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
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
  return c.json({ ok: true, id });
});

app.get("/api/admin/pins", async (c) => {
  const session = c.get("session");
  if (!session?.scopes.includes("admin")) return c.json({ error: "Forbidden" }, 403);
  const rows = await listAllPins(c.env);
  return c.json({
    pins: rows.map((p) => ({
      id: p.id,
      label: p.label,
      scopes: parseScopesField(p.scopes),
      active: !!p.active,
      created_at: p.created_at,
    })),
  });
});

app.post("/api/admin/pins", async (c) => {
  const session = c.get("session");
  if (!session?.scopes.includes("admin")) return c.json({ error: "Forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: string;
    pin?: string;
    scopes?: string[];
  };
  const pin = (body.pin ?? "").replace(/\D/g, "");
  const label = (body.label ?? "").trim();
  if (!label || !/^\d{6}$/.test(pin)) {
    return c.json({ error: "label and 6-digit pin required" }, 400);
  }
  const scopes = normalizeScopes(body.scopes ?? ["bells"]);
  if (!scopes.filter((s) => s !== "remote").length) {
    return c.json({ error: "at least one of bells/evacuate/admin required" }, 400);
  }
  const id = crypto.randomUUID();
  const pinHash = await bcrypt.hash(pin, 10);
  await insertPin(c.env, { id, label, pinHash, scopes });
  return c.json({ ok: true, id, label, scopes });
});

app.patch("/api/admin/pins", async (c) => {
  const session = c.get("session");
  if (!session?.scopes.includes("admin")) return c.json({ error: "Forbidden" }, 403);
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

app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
