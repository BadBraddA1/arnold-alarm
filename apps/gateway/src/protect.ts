/**
 * UniFi Protect triggers against an on-site NVR (e.g. UNVR Pro).
 *
 * Supports:
 * - webhook: POST to a full Protect Alarm Manager webhook URL
 * - alarmWebhook: POST Integration alarm-manager/webhook/{id}
 * - testSound: POST Integration speakers/{id}/test-sound (Protect built-in test tone)
 * - automation: login + private API run (best-effort)
 */

export type ActionDef =
  | { kind: "webhook"; url: string }
  | { kind: "alarmWebhook"; id: string }
  | { kind: "testSound"; speakerIds: string[] }
  | { kind: "automation"; id: string };

export type ActionMap = Record<string, ActionDef>;

type Session = {
  cookie: string;
  csrf: string;
};

let cachedSession: Session | null = null;

function protectBase() {
  const host = process.env.PROTECT_HOST;
  if (!host) throw new Error("PROTECT_HOST not set");
  const normalized = host.replace(/\/$/, "");
  if (normalized.startsWith("http")) return normalized;
  return `https://${normalized}`;
}

async function login(): Promise<Session> {
  if (cachedSession) return cachedSession;
  const user = process.env.PROTECT_USER;
  const pass = process.env.PROTECT_PASS;
  if (!user || !pass) {
    throw new Error("PROTECT_USER/PROTECT_PASS required for automation triggers");
  }

  const res = await fetch(`${protectBase()}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ username: user, password: pass, rememberMe: true }),
    // Local NVR often uses self-signed certs — Node 24+ needs this for undici
    // @ts-expect-error Node fetch dispatcher option varies by runtime
    rejectUnauthorized: false,
  }).catch(async () => {
    // Fallback via node https with insecure TLS
    const https = await import("node:https");
    const body = JSON.stringify({
      username: user,
      password: pass,
      rememberMe: true,
    });
    return new Promise<Response>((resolve, reject) => {
      const url = new URL(`${protectBase()}/api/auth/login`);
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: "POST",
          rejectUnauthorized: false,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") headers.set(k, v);
              else if (Array.isArray(v)) headers.set(k, v.join(", "));
            }
            resolve(
              new Response(text, {
                status: res.statusCode || 500,
                headers,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  });

  if (!res.ok) {
    throw new Error(`Protect login failed (${res.status})`);
  }

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookieHeader =
    setCookie.map((c) => c.split(";")[0]).join("; ") ||
    res.headers.get("set-cookie")?.split(",")[0]?.split(";")[0] ||
    "";
  const csrf =
    res.headers.get("x-csrf-token") ||
    res.headers.get("x-csrf-token".toLowerCase()) ||
    "";

  if (!cookieHeader) {
    throw new Error("Protect login returned no session cookie");
  }

  cachedSession = { cookie: cookieHeader, csrf };
  return cachedSession;
}

async function insecureFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; text: string }> {
  const https = await import("node:https");
  const u = new URL(url);
  const method = init.method || "GET";
  const body = init.body;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(init.headers || {}),
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 500,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function triggerWebhook(url: string) {
  const apiKey = process.env.PROTECT_API_KEY;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey) headers["X-API-KEY"] = apiKey;

  const result = await insecureFetch(url, {
    method: "POST",
    headers,
    body: "{}",
  });
  if (result.status >= 400) {
    throw new Error(`Webhook failed (${result.status}): ${result.text.slice(0, 200)}`);
  }
}

async function triggerAutomation(id: string) {
  const apiKey = process.env.PROTECT_API_KEY;
  // Integration API path used by Alarm Manager "run" style triggers
  if (apiKey) {
    const url = `${protectBase()}/proxy/protect/integration/v1/automations/${encodeURIComponent(id)}/run`;
    const result = await insecureFetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: "{}",
    });
    if (result.status < 400) return;
    console.warn("Integration run failed, trying session login", result.status);
  }

  const session = await login();
  const url = `${protectBase()}/proxy/protect/api/automations/${encodeURIComponent(id)}/run`;
  const result = await insecureFetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: session.cookie,
      ...(session.csrf ? { "X-CSRF-Token": session.csrf } : {}),
    },
    body: "{}",
  });
  if (result.status >= 400) {
    cachedSession = null;
    throw new Error(
      `Automation run failed (${result.status}): ${result.text.slice(0, 200)}`,
    );
  }
}

async function triggerAlarmWebhook(id: string) {
  const apiKey = process.env.PROTECT_API_KEY;
  if (!apiKey) throw new Error("PROTECT_API_KEY required for alarm webhooks");
  const url = `${protectBase()}/proxy/protect/integration/v1/alarm-manager/webhook/${encodeURIComponent(id)}`;
  const result = await insecureFetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: "{}",
  });
  if (result.status >= 400) {
    throw new Error(
      `Alarm webhook failed (${result.status}): ${result.text.slice(0, 200)}`,
    );
  }
}

async function triggerTestSound(speakerIds: string[]) {
  const apiKey = process.env.PROTECT_API_KEY;
  if (!apiKey) throw new Error("PROTECT_API_KEY required for test-sound");
  if (!speakerIds.length) throw new Error("No speakerIds configured");

  const errors: string[] = [];
  for (const id of speakerIds) {
    const url = `${protectBase()}/proxy/protect/integration/v1/speakers/${encodeURIComponent(id)}/test-sound`;
    const result = await insecureFetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: "{}",
    });
    // 204 No Content is success
    if (result.status >= 400) {
      errors.push(`${id}: ${result.status} ${result.text.slice(0, 120)}`);
    }
  }
  if (errors.length) {
    throw new Error(`test-sound failed: ${errors.join("; ")}`);
  }
}

export async function triggerAction(def: ActionDef) {
  if (def.kind === "webhook") {
    await triggerWebhook(def.url);
    return;
  }
  if (def.kind === "alarmWebhook") {
    await triggerAlarmWebhook(def.id);
    return;
  }
  if (def.kind === "testSound") {
    await triggerTestSound(def.speakerIds);
    return;
  }
  await triggerAutomation(def.id);
}
