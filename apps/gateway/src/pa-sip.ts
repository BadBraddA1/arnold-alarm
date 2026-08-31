/**
 * Convenience PA: answer SIP dial of extension (default 9090) and stream
 * caller audio live to Protect talkback. NOT for emergency codes.
 *
 * Extension 9099 (PA_TEST_EXT): SIP-only loop — Pi speaks a prompt back to the
 * phone; campus speakers stay silent. Use for Talk / softphone path checks.
 *
 * Uses @vexyl.ai/sip (G.711 → PCM @ 8 kHz) so no Asterisk is required on Debian 13.
 */
import { PassThrough } from "node:stream";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import {
  getPlaybackState,
  startLiveTalkback,
  stopTalkback,
  waitForTalkbackIdle,
} from "./talkback.js";
import {
  getTalkRegStatus,
  modeForCalledUser,
  startTalkRegistration,
  stopTalkRegistration,
} from "./talk-register.js";
import {
  createTestNotifyReport,
  patchExtReport,
  publishTestNotifyReport,
  type TestNotifyReport,
} from "./test-notify.js";
import { playLocalAction } from "./play-local.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export type PaStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  extension: string;
  testExtension: string;
  active: boolean;
  calls: number;
  mode: "sip-ua" | "disabled";
  talk: ReturnType<typeof getTalkRegStatus>;
};

type SipDialog = {
  trying?: () => Promise<void>;
  ringing?: () => Promise<void>;
  accept: (opts?: { payloadType?: number }) => Promise<void>;
  reject?: (code: number, reason: string) => Promise<void>;
  bye?: () => Promise<void>;
  sendAudioPaced?: (pcm: Buffer) => Promise<void>;
  on: (ev: string, fn: (...a: unknown[]) => void) => void;
  removeListener?: (ev: string, fn: (...a: unknown[]) => void) => void;
  rtpSession?: {
    pacingTimer?: ReturnType<typeof setTimeout> | null;
    sendQueue?: unknown[];
    remoteAddress?: string | null;
    remotePort?: number | null;
    natAddress?: string | null;
    natPort?: number | null;
    active?: boolean;
    stats?: { packetsSent?: number };
    getRemote?: () => { address?: string | null; port?: number | null };
  };
  request?: {
    uri?: string | { user?: string };
    headers?: Record<string, unknown>;
  };
  remoteUri?: string;
  remoteSdp?: {
    c?: { address?: string };
    m?: Array<{ media?: string; port?: number; c?: { address?: string } }>;
  };
};

type SipStackHandle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  call: (
    uri: string,
    options?: {
      fromUri?: string;
      payloadType?: number;
      credentials?: { user: string; password: string; realm?: string };
    },
  ) => Promise<SipDialog>;
};

let stack: SipStackHandle | null = null;
let activeCalls = 0;
let listenPort = 5060;
let extension = "9090";
let testExtension = "9099";

function detectLanIp(): string {
  const fromEnv = process.env.PA_PUBLIC_IP || process.env.PA_BIND_IP;
  if (fromEnv) return fromEnv;
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal && n.address.startsWith("192.168.")) {
        return n.address;
      }
    }
  }
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return "127.0.0.1";
}

function parseSpeakerIds(): string[] {
  const raw = process.env.PA_SPEAKER_IDS || "";
  const fromEnv = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;

  try {
    const actions = JSON.parse(process.env.ACTIONS || "{}") as Record<
      string,
      {
        kind?: string;
        speakerIds?: string[];
        steps?: Array<{ kind?: string; speakerIds?: string[] }>;
      }
    >;
    const ids = new Set<string>();
    for (const def of Object.values(actions)) {
      if (
        (def?.kind === "talkback" || def?.kind === "testSound") &&
        Array.isArray(def.speakerIds)
      ) {
        for (const id of def.speakerIds) ids.add(id);
      }
      if (def?.kind === "sequence" && Array.isArray(def.steps)) {
        for (const step of def.steps) {
          if (Array.isArray(step.speakerIds)) {
            for (const id of step.speakerIds) ids.add(id);
          }
        }
      }
    }
    return [...ids];
  } catch {
    return [];
  }
}

/** Called party from Request-URI / To — never From (that is the caller). */
function extractCalledUser(dialog: SipDialog): string {
  const candidates: string[] = [];
  const uri = dialog.request?.uri;
  if (typeof uri === "string") candidates.push(uri);
  else if (uri && typeof uri === "object" && uri.user) candidates.push(String(uri.user));

  const to = dialog.request?.headers?.to as
    | { uri?: { user?: string } | string }
    | string
    | undefined;
  if (typeof to === "string") candidates.push(to);
  else if (to?.uri) {
    if (typeof to.uri === "string") candidates.push(to.uri);
    else if (to.uri.user) candidates.push(String(to.uri.user));
  }

  for (const c of candidates) {
    const raw = String(c).trim();
    // sip:9099@host or sip:9099;user=phone
    const sipUser = raw.match(/^sip:([^@;>\s]+)/i);
    if (sipUser?.[1]) {
      try {
        return decodeURIComponent(sipUser[1]);
      } catch {
        return sipUser[1];
      }
    }
    // bare extension
    if (/^\d{3,15}$/.test(raw)) return raw;
  }
  return "";
}

function isPaEnabled() {
  return process.env.PA_ENABLED === "1" || process.env.PA_ENABLED === "true";
}

const SYSTEM_URL =
  process.env.CLOUD_SYSTEM_URL ||
  (process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll").replace(
    /\/api\/gateway\/poll\/?$/,
    "/api/system",
  );

/** Convenience PA respects global arm/disarm from the Worker. */
let armedCache: { armed: boolean; at: number } | null = null;

async function isSystemArmed(): Promise<boolean> {
  if (armedCache && Date.now() - armedCache.at < 15_000) {
    return armedCache.armed;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(SYSTEM_URL, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) return true; // fail open on HTTP errors
    const data = (await res.json()) as { armed?: boolean };
    const armed = data.armed !== false;
    armedCache = { armed, at: Date.now() };
    return armed;
  } catch (err) {
    console.warn("[pa] could not read /api/system — allowing PA", err);
    return true;
  }
}

function loadAssetPcm(name: string): Buffer {
  const candidates = [
    join(here, "..", "assets", name),
    join(process.cwd(), "assets", name),
    join(process.env.HOME || "", ".config/arnold-alarm/audio", name),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path);
  }
  return Buffer.alloc(0);
}

function loadTestPromptPcm(): Buffer {
  const fromEnv = process.env.PA_TEST_PROMPT;
  if (fromEnv && existsSync(fromEnv)) return readFileSync(fromEnv);
  const pcm = loadAssetPcm("pa-sip-test.pcm");
  if (pcm.length) return pcm;

  // Fallback: 880 Hz beep ×3 (8 kHz s16le mono) if asset missing
  const sr = 8000;
  const toneMs = 250;
  const gapMs = 150;
  const chunks: Buffer[] = [];
  for (let i = 0; i < 3; i++) {
    const n = Math.floor((sr * toneMs) / 1000);
    const tone = Buffer.alloc(n * 2);
    for (let s = 0; s < n; s++) {
      const v = Math.sin((2 * Math.PI * 880 * s) / sr) * 0.35 * 32767;
      tone.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v))), s * 2);
    }
    chunks.push(tone);
    chunks.push(Buffer.alloc(Math.floor((sr * gapMs) / 1000) * 2));
  }
  return Buffer.concat(chunks);
}

function loadMenuPromptPcm(): Buffer {
  const pcm = loadAssetPcm("pa-sip-menu.pcm");
  return pcm.length ? pcm : loadTestPromptPcm();
}

function loadUnarmedPromptPcm(): Buffer {
  const pcm = loadAssetPcm("pa-sip-unarmed.pcm");
  return pcm.length ? pcm : loadTestPromptPcm();
}

function loadWaitForBeepPcm(): Buffer {
  const pcm = loadAssetPcm("pa-sip-wait-beep.pcm");
  if (pcm.length) return pcm;
  // Fallback spoken cadence: short silence so the later beep is still clear.
  return Buffer.alloc(Math.floor(8000 * 0.4) * 2);
}

function earpieceBeepPcm(): Buffer {
  const sr = 8000;
  const n = Math.floor(sr * 0.14);
  const beep = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * 880 * i) / sr) * 0.5 * 32767;
    beep.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v))), i * 2);
  }
  return beep;
}

function loadGoodbyePcm(): Buffer {
  return loadAssetPcm("pa-sip-goodbye.pcm");
}

function loadTestNotifyPcm(): Buffer {
  const fromEnv = process.env.TEST_NOTIFY_PROMPT;
  if (fromEnv && existsSync(fromEnv)) return readFileSync(fromEnv);
  const pcm = loadAssetPcm("pa-sip-test-notify.pcm");
  return pcm.length ? pcm : loadTestPromptPcm();
}

function loadTestDelayAckPcm(): Buffer {
  const fromEnv = process.env.TEST_NOTIFY_DELAY_PROMPT;
  if (fromEnv && existsSync(fromEnv)) return readFileSync(fromEnv);
  return loadAssetPcm("pa-sip-test-delay.pcm");
}

function testNotifyDelayMinutes(): number {
  return Math.max(1, Math.min(60, Number(process.env.TEST_NOTIFY_DELAY_MINUTES || 5)));
}

function testNotifyDtmfMs(): number {
  return Math.max(3000, Number(process.env.TEST_NOTIFY_DTMF_MS || 12_000));
}

function parseTestNotifyExts(): string[] {
  const raw = (process.env.TEST_NOTIFY_EXTS || "").trim();
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function parseTestNotifyLabels(): Record<string, string> {
  const raw = (process.env.TEST_NOTIFY_LABELS || "").trim();
  const labels: Record<string, string> = {};
  if (!raw) return labels;
  for (const part of raw.split(/[,;]+/)) {
    const seg = part.trim();
    if (!seg) continue;
    const colon = seg.indexOf(":");
    if (colon > 0) {
      const ext = seg.slice(0, colon).trim();
      const label = seg.slice(colon + 1).trim();
      if (ext && label) labels[ext] = label;
    }
  }
  return labels;
}

function testNotifyPromptReady(): boolean {
  const fromEnv = process.env.TEST_NOTIFY_PROMPT;
  if (fromEnv && existsSync(fromEnv)) return true;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "assets", "pa-sip-test-notify.pcm"),
    join(process.cwd(), "assets", "pa-sip-test-notify.pcm"),
    join(process.env.HOME || "", ".config/arnold-alarm/audio/pa-sip-test-notify.pcm"),
  ];
  return candidates.some((p) => existsSync(p));
}

export function getTestNotifyConfig() {
  const exts = parseTestNotifyExts();
  const labels = parseTestNotifyLabels();
  return {
    exts: exts.map((ext) => ({ ext, label: labels[ext] || ext })),
    delayMinutes: testNotifyDelayMinutes(),
    dtmfMs: testNotifyDtmfMs(),
    notifyOnly: isSpeakerCheckNotifyOnly(),
    promptReady: testNotifyPromptReady(),
    configured: exts.length > 0,
  };
}

/** When true, speaker check rings desk phones only — campus horns stay silent. */
export function isSpeakerCheckNotifyOnly(): boolean {
  const v = (process.env.SPEAKER_CHECK_NOTIFY_ONLY || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function getTestNotifyStatus() {
  return getTestNotifyConfig();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Before speaker check: ring configured desk phones and play a stand-by prompt.
 * Press 0 during/after the prompt to delay campus horns (not another desk ring).
 */
export async function notifyDeskPhonesOfTest(meta?: {
  requestedBy?: string;
  playId?: string;
  hornsAt?: number | null;
}): Promise<TestNotifyReport> {
  const exts = parseTestNotifyExts();
  const labels = parseTestNotifyLabels();
  const emptyReport = (): TestNotifyReport => ({
    id: crypto.randomUUID(),
    state: "complete",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    requestedBy: meta?.requestedBy,
    playId: meta?.playId,
    notifyOnly: isSpeakerCheckNotifyOnly(),
    delayMinutes: 0,
    delayed: false,
    delayedBy: [],
    hornsAt: meta?.hornsAt ?? null,
    extensions: [],
  });

  if (!exts.length) {
    const report = emptyReport();
    report.configError =
      "TEST_NOTIFY_EXTS is not set in gateway.env — desk phones will not ring. Add e.g. TEST_NOTIFY_EXTS=0023";
    report.promptReady = testNotifyPromptReady();
    await publishTestNotifyReport(report);
    console.error(`[test-notify] ${report.configError}`);
    return report;
  }

  const report = createTestNotifyReport({
    exts,
    labels,
    requestedBy: meta?.requestedBy,
    playId: meta?.playId,
    notifyOnly: isSpeakerCheckNotifyOnly(),
    delayMinutes: testNotifyDelayMinutes(),
  });
  report.hornsAt = meta?.hornsAt ?? null;
  report.promptReady = testNotifyPromptReady();
  if (!report.promptReady) {
    report.configError =
      "Spoken notify prompt missing — copy pa-sip-test-notify.pcm to ~/.config/arnold-alarm/audio/ (run render-notify-pcm.sh on a Mac). Until then you may only hear beeps, not the press-0 message.";
    console.warn(`[test-notify] ${report.configError}`);
  }
  await publishTestNotifyReport(report);

  if (!stack) {
    console.warn("[test-notify] SIP stack not ready — skipping desk phone calls");
    for (const ext of exts) {
      patchExtReport(report, ext, {
        status: "failed",
        error: "sip_stack_unavailable",
        finishedAt: Date.now(),
      });
    }
    report.state = "complete";
    report.finishedAt = Date.now();
    await publishTestNotifyReport(report);
    return report;
  }

  const talkHost = (process.env.PA_TALK_HOST || "192.168.1.1").trim();
  const ringMs = Math.max(8_000, Number(process.env.TEST_NOTIFY_RING_MS || 25_000));
  const dtmfMs = testNotifyDtmfMs();
  const pcm = loadTestNotifyPcm();
  const delayAck = loadTestDelayAckPcm();
  const caller = testNotifyCallIdentity();

  console.log(`[test-notify] calling ${exts.join(", ")} via ${talkHost}`);

  await Promise.all(
    exts.map(async (ext) => {
      const uri = `sip:${ext}@${talkHost}`;
      let dialog: SipDialog | null = null;
      try {
        patchExtReport(report, ext, { status: "ringing", ringStartedAt: Date.now() });
        await publishTestNotifyReport(report);

        const callP = stack!.call(uri, {
          fromUri: caller.fromUri,
          payloadType: 0,
          ...(caller.credentials ? { credentials: caller.credentials } : {}),
        });
        dialog = await Promise.race([
          callP,
          sleep(ringMs).then(() => {
            throw new Error(`no answer within ${Math.round(ringMs / 1000)}s`);
          }),
        ]);

        patchExtReport(report, ext, {
          status: "answered",
          answeredAt: Date.now(),
        });
        await publishTestNotifyReport(report);

        await prepareDeskPhoneAudio(dialog);

        patchExtReport(report, ext, { status: "playing_prompt" });
        await publishTestNotifyReport(report);

        // Lead with a beep so the callee knows audio is live before the spoken prompt.
        await playToPhone(dialog, earpieceBeepPcm());
        await sleep(350);

        let digit: string | null = null;
        if (pcm.length) {
          digit = await playPromptUntilDigit(dialog, pcm, dtmfMs);
        }
        if (!digit) {
          digit = await waitForDtmf(dialog, Math.min(8000, dtmfMs));
        }

        if (digit === "0") {
          report.delayedBy.push(ext);
          patchExtReport(report, ext, { status: "delayed", digit: "0" });
          if (delayAck.length) {
            await playToPhone(dialog, delayAck);
          }
          console.log(`[test-notify] ${ext} requested delay`);
        } else {
          patchExtReport(report, ext, {
            status: "acknowledged",
            digit: digit || null,
          });
        }

        await hangUpWithGoodbye(dialog);
        patchExtReport(report, ext, { finishedAt: Date.now() });
        await publishTestNotifyReport(report);
        console.log(`[test-notify] ${ext} ${digit === "0" ? "delayed" : "acknowledged"}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const noAnswer = /no answer/i.test(message);
        patchExtReport(report, ext, {
          status: noAnswer ? "no_answer" : "failed",
          error: message,
          finishedAt: Date.now(),
        });
        console.warn(`[test-notify] ${ext} failed:`, message);
        try {
          if (dialog) await hangUpWithGoodbye(dialog);
        } catch {
          /* ignore */
        }
        await publishTestNotifyReport(report);
      }
    }),
  );

  report.delayed = report.delayedBy.length > 0;
  report.delayMinutes = report.delayed ? testNotifyDelayMinutes() : 0;
  if (report.delayed) {
    report.hornsAt = Date.now() + report.delayMinutes * 60_000;
    console.log(
      `[test-notify] delay ${report.delayMinutes}m requested by ${report.delayedBy.join(", ")}`,
    );
  }
  report.state = "complete";
  report.finishedAt = Date.now();
  await publishTestNotifyReport(report);
  return report;
}

function loadPhoneTestPromptPcm(): Buffer {
  const fromEnv = process.env.TEST_PHONE_CALL_PROMPT;
  if (fromEnv && existsSync(fromEnv)) return readFileSync(fromEnv);
  const pcm = loadAssetPcm("pa-sip-phone-test.pcm");
  if (pcm.length) return pcm;
  return earpieceBeepPcm();
}

/** Ring one desk phone with a short beep + test clip — no horns, no press-0 flow. */
export async function testCallDeskPhone(
  ext: string,
  meta?: { requestedBy?: string; playId?: string },
): Promise<TestNotifyReport> {
  const normalized = ext.trim();
  if (!/^\d{3,5}$/.test(normalized)) {
    throw Object.assign(new Error(`Invalid extension: ${ext}`), { status: 400 });
  }

  const labels = parseTestNotifyLabels();
  const label = labels[normalized] || normalized;
  const report = createTestNotifyReport({
    exts: [normalized],
    labels: { ...labels, [normalized]: label },
    requestedBy: meta?.requestedBy,
    playId: meta?.playId,
    notifyOnly: true,
    delayMinutes: 0,
  });
  report.promptReady = true;
  await publishTestNotifyReport(report);

  if (!stack) {
    patchExtReport(report, normalized, {
      status: "failed",
      error: "sip_stack_unavailable",
      finishedAt: Date.now(),
    });
    report.state = "complete";
    report.finishedAt = Date.now();
    await publishTestNotifyReport(report);
    return report;
  }

  const talkHost = (process.env.PA_TALK_HOST || "192.168.1.1").trim();
  const ringMs = Math.max(8_000, Number(process.env.TEST_PHONE_RING_MS || 20_000));
  const caller = testNotifyCallIdentity();
  const uri = `sip:${normalized}@${talkHost}`;
  let dialog: SipDialog | null = null;

  console.log(`[phone-test] calling ${normalized} (${label}) via ${talkHost}`);

  try {
    patchExtReport(report, normalized, { status: "ringing", ringStartedAt: Date.now() });
    await publishTestNotifyReport(report);

    const callP = stack.call(uri, {
      fromUri: caller.fromUri,
      payloadType: 0,
      ...(caller.credentials ? { credentials: caller.credentials } : {}),
    });
    dialog = await Promise.race([
      callP,
      sleep(ringMs).then(() => {
        throw new Error(`no answer within ${Math.round(ringMs / 1000)}s`);
      }),
    ]);

    patchExtReport(report, normalized, { status: "answered", answeredAt: Date.now() });
    await publishTestNotifyReport(report);

    await prepareDeskPhoneAudio(dialog);

    patchExtReport(report, normalized, { status: "playing_prompt" });
    await publishTestNotifyReport(report);

    await playToPhone(dialog, earpieceBeepPcm());
    await sleep(250);
    await playToPhone(dialog, loadPhoneTestPromptPcm());
    await sleep(200);
    await hangUpWithGoodbye(dialog);

    patchExtReport(report, normalized, {
      status: "acknowledged",
      finishedAt: Date.now(),
    });
    console.log(`[phone-test] ${normalized} (${label}) ok`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const noAnswer = /no answer/i.test(message);
    patchExtReport(report, normalized, {
      status: noAnswer ? "no_answer" : "failed",
      error: message,
      finishedAt: Date.now(),
    });
    console.warn(`[phone-test] ${normalized} failed:`, message);
    try {
      if (dialog) await hangUpWithGoodbye(dialog);
    } catch {
      /* ignore */
    }
  }

  report.state = "complete";
  report.finishedAt = Date.now();
  await publishTestNotifyReport(report);
  return report;
}

function ivrApiUrl(): string {
  return (
    process.env.CLOUD_IVR_URL ||
    (process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll").replace(
      /\/api\/gateway\/poll\/?$/,
      "/api/gateway/ivr-alarm",
    )
  );
}

async function authorizeIvrAlarm(
  pin: string,
  actionId: string,
): Promise<{
  ok: boolean;
  armed?: boolean;
  held?: boolean;
  error?: string;
  status?: number;
}> {
  const secret = process.env.GATEWAY_POLL_SECRET || "";
  if (!secret) {
    return { ok: false, error: "no_gateway_secret", status: 500 };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(ivrApiUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pin, actionId }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      armed?: boolean;
      held?: boolean;
      error?: string;
    };
    if (!res.ok) {
      return { ok: false, error: data.error || `http_${res.status}`, status: res.status };
    }
    return {
      ok: true,
      armed: data.armed,
      held: data.held,
      error: data.error,
      status: res.status,
    };
  } catch (err) {
    console.error("[pa] ivr-alarm authorize failed", err);
    return { ok: false, error: "network", status: 502 };
  }
}

async function collectPinDigits(
  dialog: SipDialog,
  timeoutMs: number,
): Promise<string | null> {
  let pin = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await waitForDtmf(dialog, Math.max(500, deadline - Date.now()));
    if (d === null) return pin.length === 6 ? pin : null;
    if (d === "*") return null;
    if (d === "#") return pin.length === 6 ? pin : null;
    if (/^\d$/.test(d)) {
      pin += d;
      if (pin.length >= 6) return pin.slice(0, 6);
    }
  }
  return pin.length === 6 ? pin : null;
}

async function collectOneOf(
  dialog: SipDialog,
  allowed: string[],
  timeoutMs: number,
): Promise<string | null> {
  const set = new Set(allowed);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await waitForDtmf(dialog, Math.max(500, deadline - Date.now()));
    if (d === null) return null;
    if (d === "*") return "*";
    if (set.has(d)) return d;
  }
  return null;
}

function ivrFobArmUrl(): string {
  return (
    process.env.CLOUD_FOB_ARM_URL ||
    (process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll").replace(
      /\/api\/gateway\/poll\/?$/,
      "/api/gateway/fob/arm",
    )
  );
}

function ivrSystemToggleUrl(): string {
  return (
    process.env.CLOUD_SYSTEM_TOGGLE_URL ||
    (process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll").replace(
      /\/api\/gateway\/poll\/?$/,
      "/api/gateway/system/toggle",
    )
  );
}

async function authorizeIvrFobArm(
  pin: string,
): Promise<{
  ok: boolean;
  fobName?: string;
  expiresAt?: number;
  error?: string;
  status?: number;
}> {
  const secret = process.env.GATEWAY_POLL_SECRET || "";
  if (!secret) return { ok: false, error: "no_gateway_secret", status: 500 };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(ivrFobArmUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pin }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      fobName?: string;
      expiresAt?: number;
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.error || data.message || `http_${res.status}`,
        status: res.status,
      };
    }
    return {
      ok: true,
      fobName: data.fobName,
      expiresAt: data.expiresAt,
    };
  } catch (err) {
    console.error("[pa] ivr fob arm failed", err);
    return { ok: false, error: "network", status: 502 };
  }
}

async function authorizeIvrSystemToggle(
  pin: string,
): Promise<{
  ok: boolean;
  armed?: boolean;
  label?: string;
  error?: string;
  status?: number;
}> {
  const secret = process.env.GATEWAY_POLL_SECRET || "";
  if (!secret) return { ok: false, error: "no_gateway_secret", status: 500 };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(ivrSystemToggleUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pin }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      armed?: boolean;
      label?: string;
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.error || data.message || `http_${res.status}`,
        status: res.status,
      };
    }
    return {
      ok: true,
      armed: data.armed,
      label: data.label,
    };
  } catch (err) {
    console.error("[pa] ivr system toggle failed", err);
    return { ok: false, error: "network", status: 502 };
  }
}

async function handleIvrFobArm(dialog: SipDialog): Promise<"done" | "cancel"> {
  const timeoutMs = Math.max(15_000, Number(process.env.PA_IVR_TIMEOUT_MS || 30_000));
  const pinP = collectPinDigits(dialog, timeoutMs);
  const pinPlay = playToPhone(dialog, loadAssetPcm("pa-sip-enter-pin.pcm"));
  const pinRace = await Promise.race([
    pinP.then((p) => ({ kind: "pin" as const, p })),
    pinPlay.then(() => ({ kind: "play" as const })),
  ]);
  if (pinRace.kind === "pin") stopPhonePlayback(dialog);
  const pin = pinRace.kind === "pin" ? pinRace.p : await pinP;
  if (!pin) {
    console.log("[pa] IVR fob arm — PIN cancelled or incomplete");
    return "cancel";
  }

  console.log("[pa] IVR fob arm — authorizing");
  const auth = await authorizeIvrFobArm(pin);
  if (!auth.ok) {
    if (auth.error === "incorrect_pin") {
      await playToPhone(dialog, loadAssetPcm("pa-sip-bad-pin.pcm"));
    } else {
      await playToPhone(dialog, loadAssetPcm("pa-sip-not-allowed.pcm"));
    }
    return "done";
  }

  await playToPhone(dialog, loadAssetPcm("pa-sip-alarm-sent.pcm"));
  console.log(
    `[pa] IVR fob armed — ${auth.fobName || "fob"} until ${auth.expiresAt ? new Date(auth.expiresAt).toISOString() : "?"}`,
  );
  return "done";
}

async function handleIvrSystemToggle(dialog: SipDialog): Promise<"done" | "cancel"> {
  const timeoutMs = Math.max(15_000, Number(process.env.PA_IVR_TIMEOUT_MS || 30_000));
  const pinP = collectPinDigits(dialog, timeoutMs);
  const pinPlay = playToPhone(dialog, loadAssetPcm("pa-sip-enter-pin.pcm"));
  const pinRace = await Promise.race([
    pinP.then((p) => ({ kind: "pin" as const, p })),
    pinPlay.then(() => ({ kind: "play" as const })),
  ]);
  if (pinRace.kind === "pin") stopPhonePlayback(dialog);
  const pin = pinRace.kind === "pin" ? pinRace.p : await pinP;
  if (!pin) {
    console.log("[pa] IVR system arm — PIN cancelled or incomplete");
    return "cancel";
  }

  console.log("[pa] IVR system arm — authorizing");
  const auth = await authorizeIvrSystemToggle(pin);
  if (!auth.ok) {
    if (auth.error === "incorrect_pin") {
      await playToPhone(dialog, loadAssetPcm("pa-sip-bad-pin.pcm"));
    } else {
      await playToPhone(dialog, loadAssetPcm("pa-sip-not-allowed.pcm"));
    }
    return "done";
  }

  armedCache = { armed: auth.armed !== false, at: Date.now() };
  await playToPhone(dialog, loadAssetPcm("pa-sip-alarm-sent.pcm"));
  console.log(
    `[pa] IVR system ${auth.armed ? "armed" : "unarmed"}${auth.label ? ` — ${auth.label}` : ""}`,
  );
  return "done";
}

async function handleIvrAlarm(dialog: SipDialog): Promise<"done" | "cancel"> {
  const timeoutMs = Math.max(15_000, Number(process.env.PA_IVR_TIMEOUT_MS || 30_000));

  const pinP = collectPinDigits(dialog, timeoutMs);
  const pinPlay = playToPhone(dialog, loadAssetPcm("pa-sip-enter-pin.pcm"));
  const pinRace = await Promise.race([
    pinP.then((p) => ({ kind: "pin" as const, p })),
    pinPlay.then(() => ({ kind: "play" as const })),
  ]);
  if (pinRace.kind === "pin") stopPhonePlayback(dialog);
  const pin = pinRace.kind === "pin" ? pinRace.p : await pinP;
  if (!pin) {
    console.log("[pa] IVR alarm — PIN cancelled or incomplete");
    return "cancel";
  }

  const alarmP = collectOneOf(dialog, ["1", "2", "3", "*"], timeoutMs);
  const alarmPlay = playToPhone(dialog, loadAssetPcm("pa-sip-choose-alarm.pcm"));
  const alarmRace = await Promise.race([
    alarmP.then((d) => ({ kind: "digit" as const, d })),
    alarmPlay.then(() => ({ kind: "play" as const })),
  ]);
  if (alarmRace.kind === "digit") stopPhonePlayback(dialog);
  const alarmChoice = alarmRace.kind === "digit" ? alarmRace.d : await alarmP;
  if (!alarmChoice || alarmChoice === "*") {
    console.log("[pa] IVR alarm — alarm choice cancelled");
    return "cancel";
  }

  const actionId =
    alarmChoice === "1"
      ? "evacuate.code_red"
      : alarmChoice === "2"
        ? "evacuate.code_blue"
        : "__all_clear__";
  const confirmPrompt =
    alarmChoice === "1"
      ? "pa-sip-confirm-red.pcm"
      : alarmChoice === "2"
        ? "pa-sip-confirm-blue.pcm"
        : "pa-sip-confirm-clear.pcm";

  const confirmP = collectOneOf(dialog, ["#", "*"], timeoutMs);
  const confirmPlay = playToPhone(dialog, loadAssetPcm(confirmPrompt));
  const confirmRace = await Promise.race([
    confirmP.then((d) => ({ kind: "digit" as const, d })),
    confirmPlay.then(() => ({ kind: "play" as const })),
  ]);
  if (confirmRace.kind === "digit") stopPhonePlayback(dialog);
  const confirm = confirmRace.kind === "digit" ? confirmRace.d : await confirmP;
  if (confirm !== "#") {
    console.log("[pa] IVR alarm — not confirmed");
    return "cancel";
  }

  console.log(`[pa] IVR alarm — authorizing ${actionId}`);
  const auth = await authorizeIvrAlarm(pin, actionId);
  if (!auth.ok) {
    if (auth.error === "incorrect_pin") {
      await playToPhone(dialog, loadAssetPcm("pa-sip-bad-pin.pcm"));
    } else {
      await playToPhone(dialog, loadAssetPcm("pa-sip-not-allowed.pcm"));
    }
    return "done";
  }

  if (auth.held || auth.armed === false) {
    await playToPhone(dialog, loadUnarmedPromptPcm());
    return "done";
  }

  try {
    await playLocalAction(actionId);
    await playToPhone(dialog, loadAssetPcm("pa-sip-alarm-sent.pcm"));
    console.log(`[pa] IVR alarm played ${actionId}`);
  } catch (err) {
    console.error("[pa] IVR alarm play failed", err);
    await playToPhone(dialog, loadAssetPcm("pa-sip-not-allowed.pcm"));
  }
  return "done";
}

function waitForDtmf(
  dialog: SipDialog,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (digit: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        (dialog as { removeListener?: (e: string, fn: (...a: unknown[]) => void) => void }).removeListener?.(
          "dtmf",
          onDtmf,
        );
        (dialog as { removeListener?: (e: string, fn: (...a: unknown[]) => void) => void }).removeListener?.(
          "end",
          onEnd,
        );
      } catch {
        /* ignore */
      }
      resolve(digit);
    };
    const onDtmf = (...a: unknown[]) => {
      const digit = String(a[0] ?? "");
      if (digit) finish(digit);
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    dialog.on("dtmf", onDtmf);
    dialog.on("end", onEnd);
  });
}

export function getPaStatus(): PaStatus {
  return {
    enabled: isPaEnabled(),
    listening: Boolean(stack),
    port: listenPort,
    extension,
    testExtension,
    active: activeCalls > 0 || getPlaybackState().actionId === "pa.live",
    calls: activeCalls,
    mode: stack ? "sip-ua" : "disabled",
    talk: getTalkRegStatus(),
  };
}

async function playToPhone(dialog: SipDialog, pcm: Buffer): Promise<void> {
  if (!pcm.length || !dialog.sendAudioPaced) return;
  applyRemoteSdpToRtp(dialog);
  const ready = await waitForPhoneMediaReady(dialog, 8000);
  if (!ready) {
    console.warn("[pa] playToPhone — RTP remote never became ready; audio may be silent");
  }
  const sentBefore = dialog.rtpSession?.stats?.packetsSent ?? 0;
  try {
    await dialog.sendAudioPaced(pcm);
  } catch (err) {
    console.error("[pa] sendAudioPaced failed", err);
  }
  const sentAfter = dialog.rtpSession?.stats?.packetsSent ?? 0;
  if (sentAfter <= sentBefore) {
    console.warn(`[pa] playToPhone — no RTP packets sent (${sentBefore}→${sentAfter})`);
  }
}

function getRtpRemote(dialog: SipDialog): { address?: string | null; port?: number | null } {
  const rtp = dialog.rtpSession;
  if (!rtp) return {};
  if (typeof rtp.getRemote === "function") return rtp.getRemote();
  if (rtp.natAddress && rtp.natPort) return { address: rtp.natAddress, port: rtp.natPort };
  return { address: rtp.remoteAddress, port: rtp.remotePort };
}

/** UniFi Talk often returns c=0.0.0.0 — anchor media on the Talk console IP. */
function applyRemoteSdpToRtp(dialog: SipDialog): boolean {
  const rtp = dialog.rtpSession;
  const sdp = dialog.remoteSdp;
  if (!rtp || !sdp?.m?.length) return false;

  const talkHost = (process.env.PA_TALK_HOST || "192.168.1.1").trim();
  for (const m of sdp.m) {
    if (m.media !== "audio" || !m.port) continue;
    let addr = m.c?.address || sdp.c?.address || talkHost;
    if (!addr || addr === "0.0.0.0") addr = talkHost;
    rtp.remoteAddress = addr;
    rtp.remotePort = m.port;
    console.log(`[pa] outbound RTP → ${addr}:${m.port}`);
    return true;
  }
  return false;
}

async function waitForInboundRtp(
  dialog: SipDialog,
  timeoutMs: number,
): Promise<boolean> {
  if (getRtpRemote(dialog).address && getRtpRemote(dialog).port) return true;
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      dialog.removeListener?.("audio", onPkt);
      resolve(ok);
    };
    const onPkt = () => {
      const { address, port } = getRtpRemote(dialog);
      if (address && port) done(true);
    };
    dialog.on("audio", onPkt);
    const timer = setTimeout(() => done(Boolean(getRtpRemote(dialog).address)), timeoutMs);
  });
}

/** Outbound desk calls: wait until Talk has given us a media target before streaming TTS. */
async function waitForPhoneMediaReady(
  dialog: SipDialog,
  timeoutMs = 8000,
): Promise<boolean> {
  applyRemoteSdpToRtp(dialog);

  const hasRemote = () => {
    const { address, port } = getRtpRemote(dialog);
    return Boolean(address && port);
  };
  if (hasRemote()) return true;

  await waitForInboundRtp(dialog, Math.min(timeoutMs, 3000));
  if (hasRemote()) return true;

  applyRemoteSdpToRtp(dialog);
  if (hasRemote()) return true;

  // Some mobile endpoints need an outbound RTP kick before symmetric learn works.
  const rtp = dialog.rtpSession;
  if (rtp?.remoteAddress && rtp.remotePort && dialog.sendAudioPaced) {
    try {
      await dialog.sendAudioPaced(earpieceBeepPcm());
    } catch {
      /* ignore */
    }
    await waitForInboundRtp(dialog, 2000);
  }

  if (hasRemote()) return true;

  const { address, port } = getRtpRemote(dialog);
  console.warn(`[pa] phone RTP remote not ready (addr=${address || "?"} port=${port || "?"})`);
  return false;
}

function testNotifyCallIdentity(): {
  fromUri?: string;
  credentials?: { user: string; password: string };
} {
  const talkHost = (process.env.PA_TALK_HOST || "192.168.1.1").trim();
  const fromExt = (
    process.env.TEST_NOTIFY_FROM ||
    process.env.PA_TALK_USER ||
    process.env.PA_PAGE_USER ||
    ""
  ).trim();
  if (!fromExt) return {};
  const pageUser = (process.env.PA_PAGE_USER || "").trim();
  const pagePass = (process.env.PA_PAGE_PASS || "").trim();
  const talkUser = (process.env.PA_TALK_USER || "").trim();
  const talkPass = (process.env.PA_TALK_PASS || "").trim();
  const pass = fromExt === pageUser && pagePass ? pagePass : talkPass;
  const user = fromExt === pageUser && pageUser ? pageUser : talkUser || fromExt;
  if (!pass) return { fromUri: `sip:${fromExt}@${talkHost}` };
  return {
    fromUri: `sip:${user}@${talkHost}`,
    credentials: { user, password: pass },
  };
}

async function prepareDeskPhoneAudio(dialog: SipDialog): Promise<void> {
  applyRemoteSdpToRtp(dialog);
  const settleMs = Math.max(800, Number(process.env.TEST_NOTIFY_SETTLE_MS || 1500));
  await waitForPhoneMediaReady(dialog, 8000);
  if (settleMs) await sleep(settleMs);
}

/** Stop in-progress earpiece playback so DTMF can barge in. */
function stopPhonePlayback(dialog: SipDialog): void {
  const rtp = dialog.rtpSession;
  if (!rtp) return;
  if (rtp.pacingTimer) {
    clearTimeout(rtp.pacingTimer);
    rtp.pacingTimer = null;
  }
  if (Array.isArray(rtp.sendQueue)) rtp.sendQueue.length = 0;
}

/**
 * Play a prompt but jump ahead as soon as a digit arrives.
 */
async function playPromptUntilDigit(
  dialog: SipDialog,
  pcm: Buffer,
  timeoutMs: number,
): Promise<string | null> {
  const digitP = waitForDtmf(dialog, timeoutMs);
  const playP = playToPhone(dialog, pcm);
  const raced = await Promise.race([
    digitP.then((d) => ({ kind: "digit" as const, d })),
    playP.then(() => ({ kind: "play" as const })),
  ]);
  if (raced.kind === "digit") {
    stopPhonePlayback(dialog);
    return raced.d;
  }
  return digitP;
}

/** Always say goodbye before BYE on accepted calls. */
async function hangUpWithGoodbye(dialog: SipDialog): Promise<void> {
  await playToPhone(dialog, loadGoodbyePcm());
  try {
    await dialog.bye?.();
  } catch {
    /* ignore */
  }
}

async function handleSipTest(
  dialog: SipDialog,
  opts: { alreadyAccepted?: boolean } = {},
): Promise<void> {
  if (!opts.alreadyAccepted) {
    await dialog.trying?.();
    await dialog.ringing?.();
    await dialog.accept({ payloadType: 0 }); // PCMU
    activeCalls += 1;
  }
  console.log(`[pa] SIP test — prompt to phone only (no speakers)`);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeCalls = Math.max(0, activeCalls - 1);
    console.log("[pa] SIP test call ended");
  };
  dialog.on("end", cleanup);
  dialog.on("error", (err: unknown) => {
    console.error("[pa] SIP test dialog error", err);
    cleanup();
  });

  await playToPhone(dialog, loadTestPromptPcm());
  await hangUpWithGoodbye(dialog);
  cleanup();
}

async function handlePaLive(
  dialog: SipDialog,
  speakerIds: string[],
  opts: { alreadyAccepted?: boolean } = {},
): Promise<void> {
  if (!speakerIds.length) {
    console.log("[pa] rejecting PA — no speaker IDs configured");
    if (!opts.alreadyAccepted) {
      await dialog.reject?.(503, "Service Unavailable");
    } else {
      await playToPhone(dialog, loadUnarmedPromptPcm());
      await hangUpWithGoodbye(dialog);
      activeCalls = Math.max(0, activeCalls - 1);
    }
    return;
  }

  if (!(await isSystemArmed())) {
    console.log("[pa] PA blocked — system unarmed");
    if (!opts.alreadyAccepted) {
      await dialog.reject?.(480, "Temporarily Unavailable");
      return;
    }
    await playToPhone(dialog, loadUnarmedPromptPcm());
    await hangUpWithGoodbye(dialog);
    activeCalls = Math.max(0, activeCalls - 1);
    return;
  }

  if (!opts.alreadyAccepted) {
    await dialog.trying?.();
    // Skip ringing delay — answer immediately for paging.
    await dialog.accept({ payloadType: 0 }); // PCMU
    activeCalls += 1;
  }

  console.log(
    `[pa] live talkback starting (ext ${extension}) → ${speakerIds.length} speakers`,
  );

  // Volume in parallel — never block the earpiece beep.
  void (async () => {
    try {
      const { setAllSpeakerVolumes, getVolumeProfile } = await import("./protect.js");
      await setAllSpeakerVolumes(getVolumeProfile().evac);
    } catch (err) {
      console.warn("[pa] volume set failed", err);
    }
  })();

  // Capture SIP mic + inject silence so ffmpeg/talkback stay alive across VAD gaps.
  const pcm = new PassThrough({ highWaterMark: 256 * 1024 });
  let pcmBytes = 0;
  let audioChunks = 0;
  let lastSipAudioAt = 0;
  const frameBytes = 320; // 20ms @ 8kHz s16le mono
  const onAudio = (...a: unknown[]) => {
    const buf = a[0];
    let chunk: Buffer | null = null;
    if (Buffer.isBuffer(buf)) chunk = buf;
    else if (buf instanceof Uint8Array) chunk = Buffer.from(buf);
    if (!chunk || !chunk.length) return;
    lastSipAudioAt = Date.now();
    pcmBytes += chunk.length;
    audioChunks += 1;
    if (!pcm.destroyed) pcm.write(chunk);
  };
  dialog.on("audio", onAudio);

  const silencePump = setInterval(() => {
    if (pcm.destroyed) return;
    // Talk often suppresses silence — keep the encoder fed so talkback doesn't stall.
    if (!lastSipAudioAt || Date.now() - lastSipAudioAt > 40) {
      pcm.write(Buffer.alloc(frameBytes));
    }
  }, 20);

  const preambleRaw = (process.env.PA_PREAMBLE_FILE || "off").trim();
  const preambleOff =
    !preambleRaw ||
    preambleRaw.toLowerCase() === "off" ||
    preambleRaw.toLowerCase() === "none";
  if (!preambleOff) {
    try {
      const { startTalkback, POST_STOP_SETTLE_MS } = await import("./talkback.js");
      console.log(`[pa] preamble → ${preambleRaw}`);
      await startTalkback({
        actionId: "pa.preamble",
        file: preambleRaw,
        speakerIds,
        awaitDone: true,
      });
      await new Promise((r) => setTimeout(r, POST_STOP_SETTLE_MS));
    } catch (err) {
      console.error("[pa] preamble failed", err);
    }
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(silencePump);
    activeCalls = Math.max(0, activeCalls - 1);
    try {
      dialog.removeListener?.("audio", onAudio);
    } catch {
      /* ignore */
    }
    try {
      pcm.end();
    } catch {
      /* ignore */
    }
    stopTalkback();
    console.log(
      `[pa] call ended — talkback stopped (sip pcm ${pcmBytes} bytes / ${audioChunks} chunks)`,
    );
  };

  dialog.on("end", cleanup);
  dialog.on("error", (err: unknown) => {
    console.error("[pa] dialog error", err);
    cleanup();
  });

  const stats = setInterval(() => {
    if (cleaned) return;
    console.log(
      `[pa] live stats: sip pcm ${pcmBytes} bytes / ${audioChunks} chunks (speak into the phone)`,
    );
  }, 4000);

  try {
    // Prompt + arm campus path together; beep only when talkback is ready.
    const liveP = startLiveTalkback({
      actionId: "pa.live",
      speakerIds,
      pcmReadable: pcm,
      pcmSampleRate: 8000,
      awaitDone: false,
    });

    console.log("[pa] wait-for-beep prompt — arming campus talkback");
    const promptP = playToPhone(dialog, loadWaitForBeepPcm());
    await Promise.all([
      liveP.catch((err) => {
        console.error("[pa] live talkback failed", err);
        throw err;
      }),
      promptP.catch(() => undefined),
    ]);

    if (cleaned) return;
    console.log("[pa] campus ready — earpiece beep, then speak");
    try {
      await playToPhone(dialog, earpieceBeepPcm());
    } catch {
      /* ignore */
    }

    await waitForTalkbackIdle();
  } catch (err) {
    console.error("[pa] live talkback failed", err);
  } finally {
    clearInterval(stats);
    cleanup();
  }
}

/** IVR on Talk extension: 1 = page, 2 = phone-only test, * = hang up. */
async function handleIvrMenu(dialog: SipDialog, speakerIds: string[]): Promise<void> {
  await dialog.trying?.();
  await dialog.ringing?.();
  await dialog.accept({ payloadType: 0 });
  activeCalls += 1;
  console.log("[pa] IVR menu — waiting for DTMF (1=page, 2=test, 3=PIN alarm, 4=arm fob, 5=system arm/disarm)");

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeCalls = Math.max(0, activeCalls - 1);
    stopTalkback();
    console.log("[pa] IVR call ended");
  };
  dialog.on("end", cleanup);
  dialog.on("error", (err: unknown) => {
    console.error("[pa] IVR dialog error", err);
    cleanup();
  });

  const menuTimeoutMs = Math.max(8_000, Number(process.env.PA_IVR_TIMEOUT_MS || 20_000));
  let choice: string | null = null;

  for (let attempt = 0; attempt < 3 && !cleaned; attempt++) {
    choice = await playPromptUntilDigit(
      dialog,
      loadMenuPromptPcm(),
      menuTimeoutMs,
    );
    if (choice === "1" || choice === "2" || choice === "3" || choice === "4" || choice === "5" || choice === "*" || choice === "#") {
      break;
    }
    if (choice === null) break; // timeout or hangup
    console.log(`[pa] IVR ignored digit "${choice}"`);
  }

  if (cleaned) return;

  if (choice === "1") {
    console.log("[pa] IVR → page (talkback)");
    cleaned = true; // hand off — PA cleanup owns activeCalls
    await handlePaLive(dialog, speakerIds, { alreadyAccepted: true });
    return;
  }

  if (choice === "2") {
    console.log("[pa] IVR → phone-only test");
    cleaned = true; // hand off
    await handleSipTest(dialog, { alreadyAccepted: true });
    return;
  }

  if (choice === "3") {
    console.log("[pa] IVR → PIN alarm");
    await handleIvrAlarm(dialog);
    await hangUpWithGoodbye(dialog);
    cleanup();
    return;
  }

  if (choice === "4") {
    console.log("[pa] IVR → arm fob");
    await handleIvrFobArm(dialog);
    await hangUpWithGoodbye(dialog);
    cleanup();
    return;
  }

  if (choice === "5") {
    console.log("[pa] IVR → system arm/disarm");
    await handleIvrSystemToggle(dialog);
    await hangUpWithGoodbye(dialog);
    cleanup();
    return;
  }

  console.log(`[pa] IVR no valid choice (got ${choice ?? "timeout"}) — hanging up`);
  await hangUpWithGoodbye(dialog);
  cleanup();
}

export async function startPaAudioSocket(): Promise<void> {
  // Name kept for index.ts compatibility — this is the SIP UA now.
  if (!isPaEnabled()) {
    console.log("[pa] disabled (set PA_ENABLED=1 to enable convenience PA)");
    return;
  }

  extension = process.env.PA_EXT || process.env.PA_EXTENSION || "9090";
  testExtension = process.env.PA_TEST_EXT || "9099";
  listenPort = Number(process.env.PA_SIP_PORT || process.env.PA_AUDIOSOCKET_PORT || 5060);
  // If someone left AudioSocket port 9092, prefer real SIP 5060
  if (listenPort === 9092) listenPort = 5060;

  const speakerIds = parseSpeakerIds();
  if (!speakerIds.length) {
    console.warn(
      "[pa] no PA_SPEAKER_IDS — live PA (9090) disabled; SIP test ext still available",
    );
  }

  const publicAddress = detectLanIp();
  let SipStack: new (opts: Record<string, unknown>) => SipStackHandle;
  try {
    ({ SipStack } = require("@vexyl.ai/sip/stack"));
  } catch (err) {
    console.error(
      "[pa] @vexyl.ai/sip not installed — run pnpm install in apps/gateway",
      err,
    );
    return;
  }

  const talkIp = process.env.TALK_CONSOLE_IP || process.env.PA_ALLOWED_IPS || "";
  const allowedIps = talkIp
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const talkUser = (process.env.PA_TALK_USER || "").trim();
  const talkPass = (process.env.PA_TALK_PASS || "").trim();

  const s = new SipStack({
    port: listenPort,
    address: "0.0.0.0",
    publicAddress,
    udp: true,
    tcp: true,
    maxConcurrentCalls: Math.max(
      4,
      Number(process.env.PA_MAX_CONCURRENT_CALLS || 8),
    ),
    ringTimeLimit: Math.max(8_000, Number(process.env.TEST_NOTIFY_RING_MS || 25_000)),
    ...(talkUser && talkPass
      ? { credentials: { user: talkUser, password: talkPass } }
      : {}),
    ...(allowedIps.length ? { allowedIps } : {}),
    logger: {
      error: (e: unknown) => console.error("[pa/sip]", e),
      info: (m: unknown) => console.log("[pa/sip]", m),
    },
  });

  stack = s;
  s.on("invite", (...args: unknown[]) => {
    const dialog = args[0] as SipDialog;

    void (async () => {
      try {
        const called = extractCalledUser(dialog);
        const acceptAny =
          process.env.PA_ACCEPT_ANY !== "0" && process.env.PA_ACCEPT_ANY !== "false";
        const sipMode = modeForCalledUser(called);

        console.log(
          `[pa] inbound INVITE called="${called || "?"}"${sipMode ? ` mode=${sipMode}` : ""}`,
        );

        // Registered SIP lines (Alltree / Talk): mode from PA_TALK_* / PA_PAGE_*
        if (sipMode === "menu") {
          await handleIvrMenu(dialog, speakerIds);
          return;
        }
        if (sipMode === "test") {
          await handleSipTest(dialog);
          return;
        }
        if (sipMode === "pa") {
          await handlePaLive(dialog, speakerIds);
          return;
        }

        if (called === testExtension || called.endsWith(testExtension)) {
          await handleSipTest(dialog);
          return;
        }

        const isPa =
          called === extension ||
          called.endsWith(extension) ||
          (!called && acceptAny);

        if (!isPa) {
          console.log(
            `[pa] rejecting call (got "${called}", want ${extension}, ${testExtension}, or registered SIP users)`,
          );
          await dialog.reject?.(404, "Not Found");
          return;
        }

        await handlePaLive(dialog, speakerIds);
      } catch (err) {
        console.error("[pa] invite handler failed", err);
        try {
          await dialog.reject?.(500, "Server Error");
        } catch {
          /* ignore */
        }
        stopTalkback();
      }
    })();
  });

  await s.start();
  stack = s;

  // UniFi Talk Third-Party Device: register so desk phones can dial the extension
  const instance = (s as unknown as { _instance?: Parameters<typeof startTalkRegistration>[0] })
    ._instance;
  if (instance) {
    startTalkRegistration(instance, listenPort);
  }

  console.log(
    `[pa] SIP UA listening on udp/${listenPort} (PA ${extension}, test ${testExtension}, public ${publicAddress}) — convenience PA only`,
  );
  const notifyExts = parseTestNotifyExts();
  if (notifyExts.length) {
    console.log(`[pa] speaker-check will notify desk phones: ${notifyExts.join(", ")}`);
  }
  if (isSpeakerCheckNotifyOnly()) {
    console.log("[pa] SPEAKER_CHECK_NOTIFY_ONLY=1 — speaker check will not play campus horns");
  }
}

export async function stopPaAudioSocket(): Promise<void> {
  stopTalkRegistration();
  stopTalkback();
  if (!stack) return;
  try {
    await stack.stop();
  } catch {
    /* ignore */
  }
  stack = null;
}
