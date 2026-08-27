/**
 * Convenience PA: answer SIP dial of extension (default 1010) and stream
 * caller audio live to Protect talkback. NOT for emergency codes.
 *
 * Uses @vexyl.ai/sip (G.711 → PCM @ 8 kHz) so no Asterisk is required on Debian 13.
 */
import { Readable } from "node:stream";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { getPlaybackState, startLiveTalkback, stopTalkback } from "./talkback.js";

const require = createRequire(import.meta.url);

export type PaStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  extension: string;
  active: boolean;
  calls: number;
  mode: "sip-ua" | "disabled";
};

let stack: {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  on: (event: string, fn: (...args: unknown[]) => void) => void;
} | null = null;
let activeCalls = 0;
let listenPort = 5060;
let extension = "1010";

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

function calledMatchesExtension(dialog: {
  remoteUri?: string;
  request?: { uri?: string | { user?: string }; headers?: Record<string, unknown> };
}): boolean {
  const ext = extension;
  const candidates: string[] = [];
  if (typeof dialog.remoteUri === "string") candidates.push(dialog.remoteUri);
  const uri = dialog.request?.uri;
  if (typeof uri === "string") candidates.push(uri);
  else if (uri && typeof uri === "object" && uri.user) candidates.push(String(uri.user));
  // Also check To header if present on request
  const to = dialog.request?.headers?.to as { uri?: { user?: string } } | undefined;
  if (to?.uri?.user) candidates.push(String(to.uri.user));

  return candidates.some((c) => {
    if (c === ext) return true;
    if (c.includes(`:${ext}@`) || c.includes(`/${ext}@`)) return true;
    if (c.startsWith(`${ext}@`)) return true;
    try {
      const u = new URL(c.includes(":") ? c.replace(/^sip:/i, "sip:") : `sip:${c}`);
      return u.username === ext || u.pathname.replace(/^\//, "") === ext;
    } catch {
      return c.includes(ext);
    }
  }) || candidates.length === 0;
  // If we can't parse URI, accept (single-purpose PA box) — safer for Talk trunks
  // that dial via trunk without user=1010 in obvious place.
}

function isPaEnabled() {
  return process.env.PA_ENABLED === "1" || process.env.PA_ENABLED === "true";
}

export function getPaStatus(): PaStatus {
  return {
    enabled: isPaEnabled(),
    listening: Boolean(stack),
    port: listenPort,
    extension,
    active: activeCalls > 0 || getPlaybackState().actionId === "pa.live",
    calls: activeCalls,
    mode: stack ? "sip-ua" : "disabled",
  };
}

export async function startPaAudioSocket(): Promise<void> {
  // Name kept for index.ts compatibility — this is the SIP UA now.
  if (!isPaEnabled()) {
    console.log("[pa] disabled (set PA_ENABLED=1 to enable convenience PA)");
    return;
  }

  extension = process.env.PA_EXT || process.env.PA_EXTENSION || "1010";
  listenPort = Number(process.env.PA_SIP_PORT || process.env.PA_AUDIOSOCKET_PORT || 5060);
  // If someone left AudioSocket port 9092, prefer real SIP 5060
  if (listenPort === 9092) listenPort = 5060;

  const speakerIds = parseSpeakerIds();
  if (!speakerIds.length) {
    console.error(
      "[pa] no PA_SPEAKER_IDS (or talkback/testSound speakerIds in ACTIONS) — PA disabled",
    );
    return;
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
    const dialog = args[0] as {
      trying?: () => Promise<void>;
      ringing?: () => Promise<void>;
      accept: (opts?: { payloadType?: number }) => Promise<void>;
      reject?: (code: number, reason: string) => Promise<void>;
      bye?: () => Promise<void>;
      on: (ev: string, fn: (...a: unknown[]) => void) => void;
      request?: {
        uri?: string | { user?: string };
        headers?: Record<string, unknown>;
      };
      remoteUri?: string;
    };

    void (async () => {
      try {
        // Prefer matching 1010; if Talk only sends trunk digits, still accept when PA_ACCEPT_ANY=1
        const acceptAny =
          process.env.PA_ACCEPT_ANY !== "0" && process.env.PA_ACCEPT_ANY !== "false";
        if (!acceptAny && !calledMatchesExtension(dialog)) {
          console.log(`[pa] rejecting call (want ext ${extension})`);
          await dialog.reject?.(404, "Not Found");
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
    `[pa] SIP UA listening on udp/${listenPort} (ext ${extension}, public ${publicAddress}) — convenience PA only`,
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
