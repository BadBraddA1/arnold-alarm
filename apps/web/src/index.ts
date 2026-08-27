import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import bcrypt from "bcryptjs";
import { signPlayToken, signSession, verifySession } from "./auth";
import {
  checkRateLimit,
  clearRateLimit,
  insertPin,
  listActivePins,
  listAllPins,
  setPinActive,
} from "./db";
import {
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

app.use("*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await verifySession(c.env, token) : null;
  c.set("session", session);
  await next();
});

app.get("/api/config", (c) => {
  return c.json({
    gatewayUrl: c.env.GATEWAY_URL,
    bellActions: parseActionList(c.env.BELL_ACTIONS),
    evacuateAction: parseActionList(c.env.EVACUATE_ACTION)[0] ?? {
      id: "evacuate.main",
      label: "Building evacuation",
    },
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

  const allowed =
    session.scopes.includes("admin") ||
    (actionId.startsWith("bells.") && hasScope(session.scopes, "bells")) ||
    (actionId.startsWith("evacuate.") && hasScope(session.scopes, "evacuate"));
  if (!allowed) return c.json({ error: "Not allowed for this PIN." }, 403);

  const token = await signPlayToken(c.env, {
    pinId: session.pinId,
    scopes: session.scopes,
    actionId,
  });
  return c.json({
    token,
    gatewayUrl: c.env.GATEWAY_URL,
    expiresInSec: 60,
  });
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
  if (!scopes.length) return c.json({ error: "at least one scope required" }, 400);
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
  };
  if (!body.id || typeof body.active !== "boolean") {
    return c.json({ error: "id and active required" }, 400);
  }
  await setPinActive(c.env, body.id, body.active);
  return c.json({ ok: true });
});

// SPA fallback via assets binding
app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
