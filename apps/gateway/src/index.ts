import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { jwtVerify } from "jose";
import { z } from "zod";
import { triggerAction, type ActionMap } from "./protect.js";
import { getPlaybackState, stopTalkback } from "./talkback.js";

const PORT = Number(process.env.PORT || 8787);
const PLAY_JWT_SECRET = process.env.PLAY_JWT_SECRET || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const POLL_URL =
  process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll";
const ACK_URL =
  process.env.CLOUD_ACK_URL || "https://alarm.arnoldcoc.org/api/gateway/ack";
const POLL_SECRET = process.env.GATEWAY_POLL_SECRET || "";
const POLL_MS = Number(process.env.CLOUD_POLL_MS || 2000);

type ScheduledJob = {
  id: string;
  actionId: string;
  fireAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const scheduled = new Map<string, ScheduledJob>();

function parseActions(): ActionMap {
  try {
    return JSON.parse(process.env.ACTIONS || "{}") as ActionMap;
  } catch {
    console.error("Invalid ACTIONS JSON");
    return {};
  }
}

const actions = parseActions();

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function verifyPlayToken(token: string, actionId: string) {
  if (!PLAY_JWT_SECRET) throw new Error("PLAY_JWT_SECRET not configured");
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(PLAY_JWT_SECRET),
  );
  if (payload.typ !== "play") throw new Error("Invalid token type");
  if (String(payload.actionId) !== actionId) throw new Error("actionId mismatch");
  return payload;
}

async function runAction(
  actionId: string,
  options: { loop?: boolean; repeat?: number } = {},
) {
  if (actionId === "__stop__") {
    stopTalkback();
    return;
  }
  const def = actions[actionId];
  if (!def) {
    throw Object.assign(new Error(`Unknown action: ${actionId}`), { status: 404 });
  }
  const repeat =
    options.repeat ??
    (def.kind === "talkback" && def.repeat ? def.repeat : undefined);
  await triggerAction(def, { loop: options.loop, repeat, actionId });
}

function listScheduled() {
  return [...scheduled.values()]
    .map(({ id, actionId, fireAt }) => ({ id, actionId, fireAt }))
    .sort((a, b) => a.fireAt - b.fireAt);
}

function cancelJob(id: string): boolean {
  const job = scheduled.get(id);
  if (!job) return false;
  clearTimeout(job.timer);
  scheduled.delete(id);
  return true;
}

function scheduleJob(actionId: string, delayMs: number) {
  const id = crypto.randomUUID();
  const fireAt = Date.now() + delayMs;
  const timer = setTimeout(() => {
    scheduled.delete(id);
    void runAction(actionId).catch((err) => {
      console.error(`[schedule] failed ${actionId}`, err);
    });
  }, delayMs);
  scheduled.set(id, { id, actionId, fireAt, timer });
  return { id, actionId, fireAt };
}

async function ackCloud(id: string, ok: boolean, error?: string) {
  if (!POLL_SECRET) return;
  try {
    await fetch(ACK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${POLL_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id, ok, error }),
    });
  } catch (err) {
    console.error("[poll] ack failed", err);
  }
}

async function pollCloudOnce() {
  if (!POLL_SECRET) return;
  let res: Response;
  try {
    res = await fetch(POLL_URL, {
      headers: { Authorization: `Bearer ${POLL_SECRET}` },
    });
  } catch (err) {
    console.error("[poll] fetch failed", err);
    return;
  }
  if (!res.ok) {
    console.error("[poll] bad status", res.status);
    return;
  }
  const data = (await res.json()) as {
    jobs?: Array<{
      id: string;
      actionId: string;
      delayMinutes: number;
      label: string;
      loop?: boolean;
      command?: string;
    }>;
  };
  for (const job of data.jobs || []) {
    console.log(
      `[poll] job ${job.id} ${job.command || "play"} ${job.actionId} delay=${job.delayMinutes} from ${job.label}`,
    );
    try {
      if (job.command === "stop") {
        stopTalkback();
        await ackCloud(job.id, true);
        continue;
      }
      if (job.delayMinutes > 0) {
        scheduleJob(job.actionId, job.delayMinutes * 60_000);
        await ackCloud(job.id, true);
      } else {
        await runAction(job.actionId, { loop: job.loop });
        await ackCloud(job.id, true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      console.error(`[poll] job failed ${job.id}`, message);
      await ackCloud(job.id, false, message);
    }
  }
}

const playSchema = z.object({
  actionId: z.string().min(1),
  token: z.string().min(1),
  loop: z.boolean().optional(),
});

const stopSchema = z.object({
  token: z.string().min(1),
});

const scheduleSchema = z.object({
  actionId: z.string().min(1),
  token: z.string().min(1),
  delayMinutes: z.number().int().min(1).max(120).default(15),
});

async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const playback = getPlaybackState();
    sendJson(res, 200, {
      ok: true,
      service: "arnold-alarm-gateway",
      actions: Object.keys(actions),
      scheduled: listScheduled().length,
      poll: Boolean(POLL_SECRET),
      playback,
      now: Date.now(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/playback") {
    sendJson(res, 200, getPlaybackState());
    return;
  }

  if (req.method === "GET" && url.pathname === "/schedule") {
    sendJson(res, 200, { jobs: listScheduled() });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/schedule/")) {
    const id = url.pathname.slice("/schedule/".length);
    const ok = cancelJob(id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Not found" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/play") {
    try {
      const raw = await readBody(req);
      const body = playSchema.parse(JSON.parse(raw || "{}"));
      await verifyPlayToken(body.token, body.actionId);
      await runAction(body.actionId, { loop: body.loop });
      sendJson(res, 200, { ok: true, playback: getPlaybackState() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Play failed";
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status: number }).status)
          : message.includes("token") || message.includes("mismatch")
            ? 401
            : 500;
      console.error("[play]", message);
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    try {
      const raw = await readBody(req);
      const body = stopSchema.parse(JSON.parse(raw || "{}"));
      const { payload } = await jwtVerify(
        body.token,
        new TextEncoder().encode(PLAY_JWT_SECRET),
      );
      if (payload.typ !== "play") throw new Error("Invalid token type");
      stopTalkback();
      sendJson(res, 200, { ok: true, playback: getPlaybackState() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stop failed";
      const status =
        message.includes("token") || message.includes("Invalid") ? 401 : 500;
      console.error("[stop]", message);
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/schedule") {
    try {
      const raw = await readBody(req);
      const body = scheduleSchema.parse(JSON.parse(raw || "{}"));
      await verifyPlayToken(body.token, body.actionId);
      if (!actions[body.actionId]) {
        sendJson(res, 404, { error: `Unknown action: ${body.actionId}` });
        return;
      }
      const job = scheduleJob(body.actionId, body.delayMinutes * 60_000);
      sendJson(res, 200, { ok: true, job });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Schedule failed";
      const status =
        message.includes("token") || message.includes("mismatch") ? 401 : 500;
      console.error("[schedule]", message);
      sendJson(res, status, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

if (!PLAY_JWT_SECRET) {
  console.warn("WARNING: PLAY_JWT_SECRET is empty — play tokens will fail");
}
if (!POLL_SECRET) {
  console.warn("WARNING: GATEWAY_POLL_SECRET empty — cloud poll disabled");
} else {
  setInterval(() => {
    void pollCloudOnce();
  }, POLL_MS);
  void pollCloudOnce();
  console.log(`cloud poll every ${POLL_MS}ms → ${POLL_URL}`);
}

createServer((req, res) => {
  void handler(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`arnold-alarm gateway listening on :${PORT}`);
  console.log(`actions: ${Object.keys(actions).join(", ") || "(none)"}`);
});
