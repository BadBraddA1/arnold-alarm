import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { jwtVerify } from "jose";
import { z } from "zod";
import {
  triggerAction,
  checkProtectHealth,
  listProtectSpeakers,
  setVolumeProfile,
  getVolumeProfile,
  withActionVolume,
  type ActionMap,
} from "./protect.js";
import { getPlaybackState, stopTalkback, stopTalkbackAndWait } from "./talkback.js";
import {
  getPaStatus,
  getTestNotifyStatus,
  isSpeakerCheckNotifyOnly,
  startPaAudioSocket,
} from "./pa-sip.js";
import { handleCloudJob } from "./cloud-jobs.js";
import { startAblyPush } from "./ably-push.js";
import { getLatestTestNotifyReport } from "./test-notify.js";
import { agentAuthorized, runAgentAction } from "./agent-remote.js";

const PORT = Number(process.env.PORT || 8787);
const PLAY_JWT_SECRET = process.env.PLAY_JWT_SECRET || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const POLL_URL =
  process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll";
const ACK_URL =
  process.env.CLOUD_ACK_URL || "https://alarm.arnoldcoc.org/api/gateway/ack";
const TELEMETRY_URL =
  process.env.CLOUD_TELEMETRY_URL ||
  "https://alarm.arnoldcoc.org/api/gateway/telemetry";
const POLL_SECRET = process.env.GATEWAY_POLL_SECRET || "";
const POLL_MS = Number(process.env.CLOUD_POLL_MS || 60_000);
const TELEMETRY_MS = Number(process.env.CLOUD_TELEMETRY_MS || 30_000);

// Optional local defaults; cloud Admin settings override via poll.
if (process.env.BELL_VOLUME || process.env.EVAC_VOLUME) {
  setVolumeProfile({
    bells: process.env.BELL_VOLUME ? Number(process.env.BELL_VOLUME) : undefined,
    evac: process.env.EVAC_VOLUME ? Number(process.env.EVAC_VOLUME) : undefined,
  });
}

type ScheduledJob = {
  id: string;
  actionId: string;
  fireAt: number;
  timer: ReturnType<typeof setTimeout>;
  skipTestNotify?: boolean;
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
  options: {
    loop?: boolean;
    repeat?: number;
    skipTestNotify?: boolean;
    requestedBy?: string;
    playId?: string;
  } = {},
) {
  if (actionId === "__all_clear__") {
    await withActionVolume("evacuate.code_green", async () => {
      await stopTalkbackAndWait();
      const def = actions["evacuate.code_green"];
      if (!def) {
        throw Object.assign(new Error("All clear action not configured"), {
          status: 500,
        });
      }
      // Sequence stitches start tone + Code Green ×2 in one talkback session.
      await triggerAction(def, { actionId: "evacuate.code_green" });
    });
    return;
  }
  if (actionId === "__stop__") {
    stopTalkback();
    return;
  }
  // Admin: fire start tone on one Protect speaker (actionId = test.speaker:<id>)
  if (actionId.startsWith("test.speaker:")) {
    const speakerId = actionId.slice("test.speaker:".length).trim();
    if (!/^[a-f0-9]{16,32}$/i.test(speakerId)) {
      throw Object.assign(new Error("Invalid speaker id"), { status: 400 });
    }
    const file =
      (process.env.TEST_ONE_FILE || "Test_Start_Tone.mp3").trim() ||
      "Test_Start_Tone.mp3";
    const { startTalkback } = await import("./talkback.js");
    await withActionVolume(actionId, () =>
      startTalkback({
        actionId,
        file,
        speakerIds: [speakerId],
        awaitDone: true,
      }),
    );
    return;
  }
  if (actionId.startsWith("test.phone:")) {
    const ext = actionId.slice("test.phone:".length).trim();
    const { testCallDeskPhone } = await import("./pa-sip.js");
    const result = await testCallDeskPhone(ext, {
      requestedBy: options.requestedBy,
      playId: options.playId,
    });
    const row = result.extensions[0];
    const summary = row ? `${row.ext}:${row.status}` : "unknown";
    console.log(`[play] phone test — ${summary}`);
    if (row?.status === "failed") {
      throw Object.assign(new Error(row.error || "Phone test call failed"), { status: 500 });
    }
    if (row?.status === "no_answer") {
      throw Object.assign(new Error("No answer — pick up the desk phone and try again."), {
        status: 504,
      });
    }
    return;
  }
  const def = actions[actionId];
  if (!def) {
    throw Object.assign(new Error(`Unknown action: ${actionId}`), { status: 404 });
  }
  const loop =
    typeof options.loop === "boolean"
      ? options.loop
      : actionId === "evacuate.code_red" ||
        actionId === "evacuate.code_blue" ||
        actionId === "evacuate.main";
  const repeat =
    options.repeat ??
    (def.kind === "talkback" && def.repeat ? def.repeat : undefined);
  if (actionId === "test.speakers" && !options.skipTestNotify) {
    try {
      const { notifyDeskPhonesOfTest } = await import("./pa-sip.js");
      const result = await notifyDeskPhonesOfTest({
        requestedBy: options.requestedBy,
        playId: options.playId,
      });
      if (result.extensions.length) {
        const summary = result.extensions
          .map((e) => `${e.ext}:${e.status}`)
          .join(", ");
        console.log(
          `[play] test notify ${result.state}${result.delayed ? ` delay=${result.delayMinutes}m` : ""} — ${summary}`,
        );
      }
      if (result.configError) {
        console.error(`[play] ${result.configError}`);
        if (isSpeakerCheckNotifyOnly()) {
          throw Object.assign(new Error(result.configError), { status: 500 });
        }
      }
      if (result.delayed && result.delayMinutes > 0) {
        if (isSpeakerCheckNotifyOnly()) {
          console.log("[play] speaker check delayed — notify-only, horns already skipped");
          return;
        }
        const job = scheduleJob("test.speakers", result.delayMinutes * 60_000, crypto.randomUUID(), {
          skipTestNotify: true,
        });
        console.log(
          `[play] speaker check horns delayed ${result.delayMinutes}m — job ${job.id} at ${new Date(job.fireAt).toISOString()}`,
        );
        return;
      }
    } catch (err) {
      console.warn(
        "[play] desk phone notify failed — continuing speaker check",
        err instanceof Error ? err.message : err,
      );
    }
    if (isSpeakerCheckNotifyOnly()) {
      console.log("[play] speaker check notify-only — skipping campus horns");
      return;
    }
  }
  await withActionVolume(actionId, () =>
    triggerAction(def, { loop, repeat, actionId }),
  );
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

function scheduleJob(
  actionId: string,
  delayMs: number,
  id: string = crypto.randomUUID(),
  opts: { skipTestNotify?: boolean } = {},
) {
  const fireAt = Date.now() + delayMs;
  const timer = setTimeout(() => {
    scheduled.delete(id);
    void runAction(actionId, { skipTestNotify: opts.skipTestNotify }).catch((err) => {
      console.error(`[schedule] failed ${actionId}`, err);
    });
  }, delayMs);
  scheduled.set(id, { id, actionId, fireAt, timer, skipTestNotify: opts.skipTestNotify });
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

let lastTelemetryAt = 0;

async function reportTelemetry(force = false) {
  if (!POLL_SECRET) return;
  const now = Date.now();
  if (!force && now - lastTelemetryAt < TELEMETRY_MS) return;
  lastTelemetryAt = now;
  try {
    const speakers = await listProtectSpeakers();
    await fetch(TELEMETRY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${POLL_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        speakers,
        volumes: getVolumeProfile(),
        at: Date.now(),
      }),
    });
  } catch (err) {
    console.warn(
      "[telemetry]",
      err instanceof Error ? err.message : "report failed",
    );
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
    volumes?: { bells?: number; evac?: number };
  };
  if (data.volumes) {
    setVolumeProfile(data.volumes);
  }
  for (const job of data.jobs || []) {
    await handleCloudJob(
      {
        id: job.id,
        actionId: job.actionId,
        delayMinutes: job.delayMinutes,
        label: job.label,
        loop: job.loop,
        command:
          job.command === "stop" || job.command === "all_clear"
            ? job.command
            : undefined,
      },
      data.volumes,
      cloudJobHandlers,
    );
  }
  void reportTelemetry(Boolean(data.jobs?.length));
}

const cloudJobHandlers = {
  runAction,
  scheduleJob,
  ackCloud,
  cancelLocalSchedule: cancelJob,
};

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
  delayMinutes: z.number().int().min(1).max(720).default(15),
});

async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const playback = getPlaybackState();
    let protect: { ok: boolean; error?: string; speakers?: number } = {
      ok: false,
      error: "not checked",
    };
    try {
      protect = await Promise.race([
        checkProtectHealth(),
        new Promise<typeof protect>((resolve) =>
          setTimeout(
            () => resolve({ ok: false, error: "Protect check timed out" }),
            2500,
          ),
        ),
      ]);
    } catch (err) {
      protect = {
        ok: false,
        error: err instanceof Error ? err.message : "Protect check failed",
      };
    }
    sendJson(res, 200, {
      ok: true,
      service: "arnold-alarm-gateway",
      actions: Object.keys(actions),
      scheduled: listScheduled().length,
      poll: Boolean(POLL_SECRET),
      pollMs: POLL_MS,
      ablyPush: process.env.CLOUD_ABLY_PUSH !== "0" && Boolean(POLL_SECRET),
      playback,
      protect,
      pa: getPaStatus(),
      testNotify: getTestNotifyStatus(),
      testNotifyReport: getLatestTestNotifyReport(),
      now: Date.now(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/test-notify") {
    sendJson(res, 200, {
      config: getTestNotifyStatus(),
      report: getLatestTestNotifyReport(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/playback") {
    sendJson(res, 200, getPlaybackState());
    return;
  }

  if (req.method === "GET" && url.pathname === "/speakers") {
    try {
      const speakers = await listProtectSpeakers();
      sendJson(res, 200, { speakers, volumes: getVolumeProfile() });
    } catch (err) {
      sendJson(res, 502, {
        error: err instanceof Error ? err.message : "Protect speakers failed",
      });
    }
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
      if (body.actionId === "evacuate.code_green") {
        sendJson(res, 403, {
          error: "All clear only via POST /all-clear",
        });
        return;
      }
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

  if (req.method === "POST" && url.pathname === "/all-clear") {
    try {
      const raw = await readBody(req);
      const body = stopSchema.parse(JSON.parse(raw || "{}"));
      const { payload } = await jwtVerify(
        body.token,
        new TextEncoder().encode(PLAY_JWT_SECRET),
      );
      if (payload.typ !== "play") throw new Error("Invalid token type");
      if (String(payload.actionId) !== "__all_clear__") {
        throw new Error("Token not valid for all clear");
      }
      await runAction("__all_clear__");
      sendJson(res, 200, { ok: true, playback: getPlaybackState() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "All clear failed";
      const status =
        message.includes("token") || message.includes("Invalid") ? 401 : 500;
      console.error("[all-clear]", message);
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

  if (
    (req.method === "GET" || req.method === "POST") &&
    url.pathname === "/agent"
  ) {
    if (!agentAuthorized(req, POLL_SECRET)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      let resolvedAction = "health";
      if (req.method === "GET") {
        resolvedAction = url.searchParams.get("action") || "health";
      } else {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || "{}") as { action?: string };
        resolvedAction = parsed.action || "health";
      }
      const result = await runAgentAction(resolvedAction, {
        requestedBy: "gateway-agent",
      });
      sendJson(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Agent action failed";
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status: number }).status)
          : 500;
      console.error("[agent]", message);
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
  startAblyPush(cloudJobHandlers);
  setInterval(() => {
    void pollCloudOnce();
  }, POLL_MS);
  setInterval(() => {
    void reportTelemetry(true);
  }, TELEMETRY_MS);
  void pollCloudOnce();
  console.log(
    `cloud push via Ably + fallback poll every ${POLL_MS}ms → ${POLL_URL}`,
  );
}

createServer((req, res) => {
  void handler(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`arnold-alarm gateway listening on :${PORT}`);
  console.log(`actions: ${Object.keys(actions).join(", ") || "(none)"}`);
  void import("./protect.js").then((m) => m.warmProtectSession());
  startPaAudioSocket();
});
