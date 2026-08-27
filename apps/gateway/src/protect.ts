/**
 * UniFi Protect triggers against an on-site NVR (e.g. UNVR Pro).
 *
 * Supports:
 * - webhook: POST to a full Protect Alarm Manager webhook URL
 * - alarmWebhook: POST Integration alarm-manager/webhook/{id}
 * - testSound: POST Integration speakers/{id}/test-sound (Protect built-in test tone)
 * - automation: login + private API run (best-effort)
 */

export type SequenceStep =
  | { kind: "wait"; ms: number }
  | {
      kind: "talkback";
      file: string;
      speakerIds: string[];
      repeat?: number;
    }
  | { kind: "ringtone"; ringtoneId: string; repeat?: number }
  | { kind: "testSound"; speakerIds: string[] };

export type ActionDef =
  | { kind: "webhook"; url: string }
  | { kind: "alarmWebhook"; id: string }
  | { kind: "testSound"; speakerIds: string[] }
  | { kind: "ringtone"; ringtoneId: string; repeat?: number }
  | { kind: "talkback"; file: string; speakerIds: string[]; repeat?: number }
  | { kind: "sequence"; steps: SequenceStep[] }
  | { kind: "automation"; id: string };

export type PlayOptions = {
  loop?: boolean;
  repeat?: number;
  actionId?: string;
};

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
    res.headers.get("x-updated-csrf-token") ||
    res.headers.get("x-csrf-token") ||
    res.headers.get("x-csrf-token".toLowerCase()) ||
    "";

  if (!cookieHeader) {
    throw new Error("Protect login returned no session cookie");
  }

  cachedSession = { cookie: cookieHeader, csrf };
  return cachedSession;
}

export async function getProtectAuthHeaders(): Promise<{
  cookie: string;
  csrf: string;
}> {
  const session = await login();
  return { cookie: session.cookie, csrf: session.csrf };
}

export { protectBase };

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

async function fetchSpeakerMacs(): Promise<string[]> {
  const apiKey = process.env.PROTECT_API_KEY;
  if (!apiKey) throw new Error("PROTECT_API_KEY required to list speakers");
  const result = await insecureFetch(
    `${protectBase()}/proxy/protect/integration/v1/speakers`,
    {
      headers: {
        Accept: "application/json",
        "X-API-KEY": apiKey,
      },
    },
  );
  if (result.status >= 400) {
    throw new Error(`List speakers failed (${result.status})`);
  }
  const speakers = JSON.parse(result.text) as Array<{ mac?: string }>;
  const macs = speakers.map((s) => s.mac).filter(Boolean) as string[];
  if (!macs.length) throw new Error("No speaker MAC addresses found");
  return macs;
}

let cachedRingtoneIds: Set<string> | null = null;

async function assertRingtoneExists(ringtoneId: string) {
  if (cachedRingtoneIds?.has(ringtoneId)) return;
  const session = await login();
  const result = await insecureFetch(`${protectBase()}/proxy/protect/api/bootstrap`, {
    headers: {
      Accept: "application/json",
      Cookie: session.cookie,
      ...(session.csrf ? { "X-CSRF-Token": session.csrf } : {}),
    },
  });
  if (result.status >= 400) {
    throw new Error(`Protect bootstrap failed (${result.status})`);
  }
  const data = JSON.parse(result.text) as { ringtones?: Array<{ id?: string }> };
  const ids = new Set(
    (data.ringtones || []).map((r) => r.id).filter(Boolean) as string[],
  );
  cachedRingtoneIds = ids;
  if (!ids.has(ringtoneId)) {
    throw new Error(
      `Ringtone ${ringtoneId} not found on NVR — update ACTIONS ringtoneId in gateway.env`,
    );
  }
}

async function playRingtone(ringtoneId: string, repeatTimes = 1) {
  await assertRingtoneExists(ringtoneId);
  const session = await login();
  const macs = await fetchSpeakerMacs();
  const body = JSON.stringify({
    name: "_arnold_alarm_play",
    enable: true,
    sources: [],
    conditions: [
      {
        condition: {
          type: "is",
          source: "webhook",
          value: crypto.randomUUID(),
        },
      },
    ],
    historyConditions: [],
    schedules: [],
    actions: [
      {
        type: "PLAY_SPEAKER",
        order: 0,
        metadata: {
          ringtoneId,
          repeatTimes: Math.max(1, repeatTimes),
          volume: 100,
          sources: macs.map((mac) => ({ type: "include", device: mac })),
        },
      },
    ],
    cooldown: { enable: false, timeout: 0 },
  });
  const result = await insecureFetch(
    `${protectBase()}/proxy/protect/api/automations/run`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: session.cookie,
        ...(session.csrf ? { "X-CSRF-Token": session.csrf } : {}),
      },
      body,
    },
  );
  if (result.status >= 400) {
    cachedSession = null;
    throw new Error(
      `Ringtone play failed (${result.status}): ${result.text.slice(0, 200)}`,
    );
  }
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
  let ok = 0;
  for (let i = 0; i < speakerIds.length; i++) {
    const id = speakerIds[i];
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 1200));
    }
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
    if (result.status >= 400) {
      errors.push(`${id}: ${result.status} ${result.text.slice(0, 120)}`);
    } else {
      ok++;
    }
  }
  if (!ok) {
    throw new Error(`test-sound failed: ${errors.join("; ")}`);
  }
  if (errors.length) {
    console.warn(`[test-sound] partial: ${ok}/${speakerIds.length}`, errors);
  }
}

export async function checkProtectHealth(): Promise<{
  ok: boolean;
  error?: string;
  speakers?: number;
}> {
  try {
    await login();
    const macs = await fetchSpeakerMacs();
    return { ok: true, speakers: macs.length };
  } catch (err) {
    cachedSession = null;
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Protect unreachable",
    };
  }
}

async function runSequence(
  steps: SequenceStep[],
  options: PlayOptions = {},
): Promise<void> {
  const actionId = options.actionId || "sequence";
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind === "wait") {
      const ms = Math.max(0, Math.min(120_000, Number(step.ms) || 0));
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      continue;
    }
    if (step.kind === "talkback") {
      const { startTalkback } = await import("./talkback.js");
      await startTalkback({
        actionId: `${actionId}.step${i}`,
        file: step.file,
        speakerIds: step.speakerIds,
        repeat: step.repeat,
        awaitDone: true,
      });
      continue;
    }
    if (step.kind === "ringtone") {
      await playRingtone(step.ringtoneId, step.repeat ?? 1);
      continue;
    }
    if (step.kind === "testSound") {
      await triggerTestSound(step.speakerIds);
    }
  }
}

export async function triggerAction(def: ActionDef, options: PlayOptions = {}) {
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
  if (def.kind === "ringtone") {
    // Protect PLAY_SPEAKER often no-ops or misbehaves with huge repeatTimes.
    // Real "loop until all clear" should use talkback; cap ringtone repeats.
    const repeat = options.loop
      ? Math.min(20, options.repeat ?? def.repeat ?? 10)
      : (options.repeat ?? def.repeat ?? 1);
    await playRingtone(def.ringtoneId, repeat);
    return;
  }
  if (def.kind === "talkback") {
    const { startTalkback } = await import("./talkback.js");
    await startTalkback({
      actionId: options.actionId || "talkback",
      file: def.file,
      speakerIds: def.speakerIds,
      loop: options.loop,
      repeat: options.repeat ?? def.repeat,
    });
    return;
  }
  if (def.kind === "sequence") {
    await runSequence(def.steps, options);
    return;
  }
  await triggerAutomation(def.id);
}
