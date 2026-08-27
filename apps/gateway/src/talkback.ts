/**
 * Stream local audio files to UniFi Protect AI speakers via talkback WebSocket.
 * Timing constants from unifi-bell-console phase0 (verified on UP-AI-Speaker).
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { getProtectAuthHeaders, protectBase } from "./protect.js";

export const FRAME_MS = (1024 / 24000) * 1000;
export const ARM_MS = 400;
export const LEAD_MS = 400;
export const TAIL_MS = 300;
export const SESSION_RECOVERY_MS = 7000;

export type PlaybackState = {
  active: boolean;
  actionId: string | null;
  loop: boolean;
  startedAt: number | null;
};

let abortController: AbortController | null = null;
let playbackPromise: Promise<void> | null = null;

const state: PlaybackState = {
  active: false,
  actionId: null,
  loop: false,
  startedAt: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function getPlaybackState(): PlaybackState {
  return { ...state };
}

export function stopTalkback(): boolean {
  if (!abortController) return false;
  abortController.abort();
  return true;
}

/** Split an AAC-ADTS bitstream into individual frames. */
export function splitAdts(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let off = 0;
  while (off + 7 <= buf.length) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) {
      const sync = buf.indexOf(0xff, off + 1);
      if (sync < 0) break;
      off = sync;
      continue;
    }
    const len =
      ((buf[off + 3] & 0x03) << 11) |
      (buf[off + 4] << 3) |
      (buf[off + 5] >> 5);
    if (len < 7 || off + len > buf.length) break;
    frames.push(buf.subarray(off, off + len));
    off += len;
  }
  return frames;
}

export async function encodeAdts(filePath: string): Promise<Buffer[]> {
  const argv = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    filePath,
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-b:a",
    "48k",
    "-f",
    "adts",
    "pipe:1",
  ];
  const ff = spawn("ffmpeg", argv, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let stderr = "";
  ff.stdout.on("data", (c: Buffer) => chunks.push(c));
  ff.stderr.on("data", (d) => (stderr += String(d)));
  const code = await new Promise<number>((res) =>
    ff.on("close", (c) => res(c ?? -1)),
  );
  if (code !== 0) {
    throw new Error(`ffmpeg encode failed: ${stderr.slice(0, 300)}`);
  }
  const frames = splitAdts(Buffer.concat(chunks));
  if (!frames.length) throw new Error("No AAC frames produced from audio file");
  return frames;
}

async function openTalkbackSocket(
  speakerId: string,
  cookie: string,
): Promise<WebSocket> {
  const host = new URL(protectBase()).host;
  const url = `wss://${host}/proxy/protect/ws/talkback?speaker=${encodeURIComponent(speakerId)}`;
  const ws = new WebSocket(url, {
    headers: { Cookie: cookie, Origin: `https://${host}` },
    rejectUnauthorized: false,
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("unexpected-response", (_req, res) => {
      reject(new Error(`talkback rejected: HTTP ${res.statusCode}`));
    });
    ws.on("error", reject);
  });
  return ws;
}

async function streamFrames(
  frames: Buffer[],
  sockets: WebSocket[],
  signal: AbortSignal,
): Promise<void> {
  await sleep(ARM_MS);
  const t0 = Date.now();
  for (let i = 0; i < frames.length; i++) {
    if (signal.aborted) return;
    const target = t0 + i * FRAME_MS - LEAD_MS;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frames[i]);
    }
  }
  await sleep(TAIL_MS);
}

async function runTalkbackSession(input: {
  filePath: string;
  speakerIds: string[];
  loop: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const { cookie } = await getProtectAuthHeaders();
  const frames = await encodeAdts(input.filePath);
  const sockets: WebSocket[] = [];

  try {
    for (const speakerId of input.speakerIds) {
      if (input.signal.aborted) return;
      sockets.push(await openTalkbackSocket(speakerId, cookie));
    }

    do {
      await streamFrames(frames, sockets, input.signal);
      if (!input.loop || input.signal.aborted) break;
      await sleep(SESSION_RECOVERY_MS);
    } while (!input.signal.aborted);
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function resolveAudioFile(file: string): string {
  const audioDir =
    process.env.AUDIO_DIR ||
    path.join(process.env.HOME || "", ".config/arnold-alarm/audio");
  if (path.isAbsolute(file)) return file;
  return path.join(audioDir, file);
}

export async function startTalkback(input: {
  actionId: string;
  file: string;
  speakerIds: string[];
  loop?: boolean;
}): Promise<void> {
  if (playbackPromise) {
    stopTalkback();
    try {
      await playbackPromise;
    } catch {
      /* prior session aborted */
    }
  }

  const filePath = resolveAudioFile(input.file);
  await readFile(filePath);

  const controller = new AbortController();
  abortController = controller;
  state.active = true;
  state.actionId = input.actionId;
  state.loop = Boolean(input.loop);
  state.startedAt = Date.now();

  playbackPromise = runTalkbackSession({
    filePath,
    speakerIds: input.speakerIds,
    loop: Boolean(input.loop),
    signal: controller.signal,
  })
    .catch((err) => {
      if (!controller.signal.aborted) throw err;
    })
    .finally(() => {
      if (abortController === controller) {
        abortController = null;
        playbackPromise = null;
        state.active = false;
        state.actionId = null;
        state.loop = false;
        state.startedAt = null;
      }
    });

  // Let the session arm before returning — reduces clipped starts.
  await sleep(ARM_MS + 50);
}

export async function waitForTalkbackIdle(): Promise<void> {
  if (playbackPromise) await playbackPromise;
}
