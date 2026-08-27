/**
 * Asterisk AudioSocket → live Protect talkback (convenience PA only).
 * Protocol: https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/
 */
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { getPlaybackState, startLiveTalkback, stopTalkback } from "./talkback.js";

const MSG_HANGUP = 0x00;
const MSG_UUID = 0x01;
const MSG_AUDIO_8K = 0x10;
const MSG_AUDIO_12K = 0x11;
const MSG_AUDIO_16K = 0x12;
const MSG_ERROR = 0xff;

const SAMPLE_RATE_BY_TYPE: Record<number, number> = {
  [MSG_AUDIO_8K]: 8000,
  [MSG_AUDIO_12K]: 12000,
  [MSG_AUDIO_16K]: 16000,
};

export type PaStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  active: boolean;
  calls: number;
};

let server: Server | null = null;
let activeCalls = 0;
let listenPort = 9092;

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
      if (def?.kind === "talkback" && Array.isArray(def.speakerIds)) {
        for (const id of def.speakerIds) ids.add(id);
      }
    }
    return [...ids];
  } catch {
    return [];
  }
}

function readFrame(
  buf: Buffer,
): { type: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 3) return null;
  const type = buf[0]!;
  const len = buf.readUInt16BE(1);
  if (buf.length < 3 + len) return null;
  return {
    type,
    payload: Buffer.from(buf.subarray(3, 3 + len)),
    rest: Buffer.from(buf.subarray(3 + len)),
  };
}

async function handleCall(socket: Socket) {
  const speakerIds = parseSpeakerIds();
  if (!speakerIds.length) {
    console.error("[pa] no PA_SPEAKER_IDS (or talkback speakerIds in ACTIONS)");
    socket.destroy();
    return;
  }

  activeCalls += 1;
  let sampleRate = 8000;
  let pending: Buffer = Buffer.alloc(0);
  let started = false;
  let closed = false;

  const pcm = new Readable({
    read() {
      /* push-driven */
    },
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeCalls = Math.max(0, activeCalls - 1);
    try {
      pcm.push(null);
    } catch {
      /* ignore */
    }
    stopTalkback();
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  };

  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const frame = readFrame(pending);
      if (!frame) break;
      pending = Buffer.concat([frame.rest]);

      if (frame.type === MSG_HANGUP) {
        cleanup();
        return;
      }
      if (frame.type === MSG_ERROR) {
        console.warn("[pa] AudioSocket error from Asterisk");
        cleanup();
        return;
      }
      if (frame.type === MSG_UUID) {
        const uuid = frame.payload.toString("hex");
        console.log(`[pa] call ${uuid} — opening live talkback`);
        continue;
      }
      const rate = SAMPLE_RATE_BY_TYPE[frame.type];
      if (rate == null) continue;
      sampleRate = rate;
      if (!started) {
        started = true;
        void startLiveTalkback({
          actionId: "pa.live",
          speakerIds,
          pcmReadable: pcm,
          pcmSampleRate: sampleRate,
        }).catch((err) => {
          console.error("[pa] live talkback failed", err);
          cleanup();
        });
      }
      if (!pcm.push(frame.payload)) {
        // Backpressure — drop is better than blocking the SIP call forever
      }
    }
  });

  socket.on("close", cleanup);
  socket.on("error", (err) => {
    console.error("[pa] socket error", err.message);
    cleanup();
  });
}

export function getPaStatus(): PaStatus {
  return {
    enabled: process.env.PA_ENABLED === "1" || process.env.PA_ENABLED === "true",
    listening: Boolean(server?.listening),
    port: listenPort,
    active: activeCalls > 0 || getPlaybackState().actionId === "pa.live",
    calls: activeCalls,
  };
}

export function startPaAudioSocket(): void {
  if (process.env.PA_ENABLED !== "1" && process.env.PA_ENABLED !== "true") {
    console.log("[pa] disabled (set PA_ENABLED=1 to enable convenience PA)");
    return;
  }
  listenPort = Number(process.env.PA_AUDIOSOCKET_PORT || 9092);
  if (server) return;

  server = createServer((socket) => {
    void handleCall(socket);
  });
  server.on("error", (err) => {
    console.error("[pa] AudioSocket listen failed", err);
  });
  server.listen(listenPort, "127.0.0.1", () => {
    console.log(
      `[pa] AudioSocket listening on 127.0.0.1:${listenPort} (convenience PA — not for emergency)`,
    );
  });
}

export function stopPaAudioSocket(): void {
  stopTalkback();
  if (!server) return;
  server.close();
  server = null;
}
