/**
 * Convenience PA: answer SIP dial of extension (default 1010) and stream
 * caller audio live to Protect talkback. NOT for emergency codes.
 *
 * Extension 1011 (PA_TEST_EXT): SIP-only loop — Pi speaks a prompt back to the
 * phone; campus speakers stay silent. Use for Talk / softphone path checks.
 *
 * Uses @vexyl.ai/sip (G.711 → PCM @ 8 kHz) so no Asterisk is required on Debian 13.
 */
import { Readable } from "node:stream";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { getPlaybackState, startLiveTalkback, stopTalkback } from "./talkback.js";

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
};

type SipDialog = {
  trying?: () => Promise<void>;
  ringing?: () => Promise<void>;
  accept: (opts?: { payloadType?: number }) => Promise<void>;
  reject?: (code: number, reason: string) => Promise<void>;
  bye?: () => Promise<void>;
  sendAudioPaced?: (pcm: Buffer) => Promise<void>;
  on: (ev: string, fn: (...a: unknown[]) => void) => void;
  request?: {
    uri?: string | { user?: string };
    headers?: Record<string, unknown>;
  };
  remoteUri?: string;
};

let stack: {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  on: (event: string, fn: (...args: unknown[]) => void) => void;
} | null = null;
let activeCalls = 0;
let listenPort = 5060;
let extension = "1010";
let testExtension = "1011";

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
      { kind?: string; speakerIds?: string[] }
    >;
    const ids = new Set<string>();
    for (const def of Object.values(actions)) {
      if (
        (def?.kind === "talkback" || def?.kind === "testSound") &&
        Array.isArray(def.speakerIds)
      ) {
        for (const id of def.speakerIds) ids.add(id);
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
    // sip:1011@host or sip:1011;user=phone
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
async function isSystemArmed(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(SYSTEM_URL, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) return true; // fail open on HTTP errors
    const data = (await res.json()) as { armed?: boolean };
    return data.armed !== false;
  } catch (err) {
    console.warn("[pa] could not read /api/system — allowing PA", err);
    return true;
  }
}

function loadTestPromptPcm(): Buffer {
  const candidates = [
    process.env.PA_TEST_PROMPT,
    join(here, "..", "assets", "pa-sip-test.pcm"),
    join(process.cwd(), "assets", "pa-sip-test.pcm"),
    join(process.env.HOME || "", ".config/arnold-alarm/audio/pa-sip-test.pcm"),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path);
  }

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
  };
}

async function handleSipTest(dialog: SipDialog): Promise<void> {
  await dialog.trying?.();
  await dialog.ringing?.();
  await dialog.accept({ payloadType: 0 }); // PCMU
  activeCalls += 1;
  console.log(`[pa] SIP test ${testExtension} — prompt to phone only (no speakers)`);

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

  try {
    const pcm = loadTestPromptPcm();
    if (dialog.sendAudioPaced) {
      await dialog.sendAudioPaced(pcm);
    } else {
      console.warn("[pa] sendAudioPaced missing — hang up without prompt");
    }
  } catch (err) {
    console.error("[pa] failed to play SIP test prompt", err);
  }

  try {
    await dialog.bye?.();
  } catch {
    /* ignore */
  }
  cleanup();
}

async function handlePaLive(dialog: SipDialog, speakerIds: string[]): Promise<void> {
  if (!speakerIds.length) {
    console.log("[pa] rejecting PA — no speaker IDs configured");
    await dialog.reject?.(503, "Service Unavailable");
    return;
  }

  if (!(await isSystemArmed())) {
    console.log("[pa] rejecting PA call — system unarmed");
    await dialog.reject?.(480, "Temporarily Unavailable");
    return;
  }

  await dialog.trying?.();
  await dialog.ringing?.();
  await dialog.accept({ payloadType: 0 }); // PCMU

  activeCalls += 1;
  console.log(
    `[pa] live talkback started (ext ${extension}) → ${speakerIds.length} speakers`,
  );

  const pcm = new Readable({
    read() {
      /* push-driven */
    },
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeCalls = Math.max(0, activeCalls - 1);
    try {
      pcm.push(null);
    } catch {
      /* ignore */
    }
    stopTalkback();
    console.log("[pa] call ended — talkback stopped");
  };

  dialog.on("audio", (...a: unknown[]) => {
    const buf = a[0];
    if (Buffer.isBuffer(buf)) pcm.push(buf);
    else if (buf instanceof Uint8Array) pcm.push(Buffer.from(buf));
  });
  dialog.on("end", cleanup);
  dialog.on("error", (err: unknown) => {
    console.error("[pa] dialog error", err);
    cleanup();
  });

  await startLiveTalkback({
    actionId: "pa.live",
    speakerIds,
    pcmReadable: pcm,
    pcmSampleRate: 8000,
  });
}

export async function startPaAudioSocket(): Promise<void> {
  // Name kept for index.ts compatibility — this is the SIP UA now.
  if (!isPaEnabled()) {
    console.log("[pa] disabled (set PA_ENABLED=1 to enable convenience PA)");
    return;
  }

  extension = process.env.PA_EXT || process.env.PA_EXTENSION || "1010";
  testExtension = process.env.PA_TEST_EXT || "1011";
  listenPort = Number(process.env.PA_SIP_PORT || process.env.PA_AUDIOSOCKET_PORT || 5060);
  // If someone left AudioSocket port 9092, prefer real SIP 5060
  if (listenPort === 9092) listenPort = 5060;

  const speakerIds = parseSpeakerIds();
  if (!speakerIds.length) {
    console.warn(
      "[pa] no PA_SPEAKER_IDS — live PA (1010) disabled; SIP test ext still available",
    );
  }

  const publicAddress = detectLanIp();
  let SipStack: new (opts: Record<string, unknown>) => {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    on: (event: string, fn: (...args: unknown[]) => void) => void;
  };
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

  const s = new SipStack({
    port: listenPort,
    address: "0.0.0.0",
    publicAddress,
    udp: true,
    tcp: true,
    maxConcurrentCalls: 1,
    ...(allowedIps.length ? { allowedIps } : {}),
    logger: {
      error: (e: unknown) => console.error("[pa/sip]", e),
      info: (m: unknown) => console.log("[pa/sip]", m),
    },
  });

  s.on("invite", (...args: unknown[]) => {
    const dialog = args[0] as SipDialog;

    void (async () => {
      try {
        const called = extractCalledUser(dialog);
        const acceptAny =
          process.env.PA_ACCEPT_ANY !== "0" && process.env.PA_ACCEPT_ANY !== "false";

        console.log(`[pa] inbound INVITE called="${called || "?"}"`);

        const isTest =
          called === testExtension ||
          called.endsWith(testExtension);

        if (isTest) {
          await handleSipTest(dialog);
          return;
        }

        const isPa =
          called === extension ||
          called.endsWith(extension) ||
          (!called && acceptAny);

        if (!isPa) {
          console.log(
            `[pa] rejecting call (got "${called}", want ${extension} or ${testExtension})`,
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
  console.log(
    `[pa] SIP UA listening on udp/${listenPort} (PA ${extension}, test ${testExtension}, public ${publicAddress}) — convenience PA only`,
  );
}

export async function stopPaAudioSocket(): Promise<void> {
  stopTalkback();
  if (!stack) return;
  try {
    await stack.stop();
  } catch {
    /* ignore */
  }
  stack = null;
}
