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
export const ARM_MS = 700;
export const LEAD_MS = 250;
export const TAIL_MS = 400;
export const SESSION_RECOVERY_MS = 7000;
/** Gap of silence between stitched clips in one talkback session. */
export const STITCH_GAP_MS = 450;
/** After aborting a loop (e.g. Red → All clear), let speakers settle. */
export const POST_STOP_SETTLE_MS = 900;

export type PlaybackState = {
  active: boolean;
  actionId: string | null;
  loop: boolean;
  repeat: number;
  startedAt: number | null;
};

let abortController: AbortController | null = null;
let playbackPromise: Promise<void> | null = null;

const state: PlaybackState = {
  active: false,
  actionId: null,
  loop: false,
  repeat: 1,
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

/** Stop any active talkback and wait until sockets drain + speakers settle. */
export async function stopTalkbackAndWait(
  settleMs = POST_STOP_SETTLE_MS,
): Promise<void> {
  const prior = playbackPromise;
  stopTalkback();
  if (prior) {
    try {
      await prior;
    } catch {
      /* aborted */
    }
  }
  if (settleMs > 0) await sleep(settleMs);
}

export async function encodeSilenceAdts(ms: number): Promise<Buffer[]> {
  const sec = Math.max(0.05, Math.min(5, ms / 1000));
  const argv = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=24000:cl=mono`,
    "-t",
    String(sec),
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
    throw new Error(`ffmpeg silence failed: ${stderr.slice(0, 300)}`);
  }
  return splitAdts(Buffer.concat(chunks));
}

/** Encode one or more files into a single ADTS frame list (optional silence gaps). */
export async function encodeAdtsFiles(
  filePaths: string[],
  gapMs = STITCH_GAP_MS,
): Promise<Buffer[]> {
  if (!filePaths.length) throw new Error("No audio files to encode");
  if (filePaths.length === 1) return encodeAdts(filePaths[0]);

  const gap = gapMs > 0 ? await encodeSilenceAdts(gapMs) : [];
  const frames: Buffer[] = [];
  for (let i = 0; i < filePaths.length; i++) {
    if (i > 0 && gap.length) frames.push(...gap);
    frames.push(...(await encodeAdts(filePaths[i])));
  }
  if (!frames.length) throw new Error("No AAC frames from stitched audio");
  return frames;
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

async function openTalkbackSockets(
  speakerIds: string[],
  cookie: string,
  signal: AbortSignal,
): Promise<WebSocket[]> {
  // Open all speaker sockets at once — sequential opens within ~7s floor cause silent dropouts.
  const results = await Promise.allSettled(
    speakerIds.map((speakerId) => openTalkbackSocket(speakerId, cookie)),
  );
  const sockets: WebSocket[] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const id = speakerIds[i];
    if (result.status === "fulfilled") {
      sockets.push(result.value);
    } else {
      const msg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${id}: ${msg}`);
      console.error(`[talkback] speaker ${id} failed to connect: ${msg}`);
    }
  }
  if (!sockets.length) {
    throw new Error(
      errors.length
        ? `No talkback speakers connected (${errors.join("; ")})`
        : "No talkback speakers connected",
    );
  }
  if (errors.length) {
    console.warn(`[talkback] partial speakers: ${sockets.length}/${speakerIds.length}`);
  }
  if (signal.aborted) {
    for (const ws of sockets) ws.close();
    return [];
  }
  return sockets;
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
  filePaths: string[];
  gapMs?: number;
  speakerIds: string[];
  loop: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const { cookie } = await getProtectAuthHeaders();

  if (input.loop) {
    const frames = await encodeAdts(input.filePaths[0]);
    while (!input.signal.aborted) {
      const sockets = await openTalkbackSockets(
        input.speakerIds,
        cookie,
        input.signal,
      );
      if (!sockets.length) return;
      try {
        await streamFrames(frames, sockets, input.signal);
      } finally {
        for (const ws of sockets) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      }
      if (!input.signal.aborted) await sleep(SESSION_RECOVERY_MS);
    }
    return;
  }

  // One socket session for the full stitch (tone + clip, or clip × N).
  const frames = await encodeAdtsFiles(
    input.filePaths,
    input.gapMs ?? STITCH_GAP_MS,
  );
  const sockets = await openTalkbackSockets(
    input.speakerIds,
    cookie,
    input.signal,
  );
  if (!sockets.length) return;
  try {
    await streamFrames(frames, sockets, input.signal);
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

async function streamLiveAdts(
  pcmReadable: NodeJS.ReadableStream,
  sockets: WebSocket[],
  signal: AbortSignal,
  pcmSampleRate: number,
): Promise<void> {
  await sleep(ARM_MS);
  const argv = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    String(pcmSampleRate),
    "-ac",
    "1",
    "-i",
    "pipe:0",
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
  const ff = spawn("ffmpeg", argv, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  ff.stderr.on("data", (d) => (stderr += String(d)));

  const onAbort = () => {
    try {
      pcmReadable.unpipe(ff.stdin!);
    } catch {
      /* ignore */
    }
    try {
      ff.stdin?.end();
    } catch {
      /* ignore */
    }
    ff.kill("SIGKILL");
  };
  signal.addEventListener("abort", onAbort, { once: true });

  let framesOut = 0;
  let loggedFirst = false;
  pcmReadable.pipe(ff.stdin!);
  pcmReadable.on("error", () => {
    try {
      ff.stdin?.destroy();
    } catch {
      /* ignore */
    }
  });

  let pending = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    ff.stdout.on("data", (chunk: Buffer) => {
      if (signal.aborted) return;
      pending = Buffer.concat([pending, chunk]);
      // Keep a small remainder for incomplete frames
      while (pending.length >= 7) {
        if (pending[0] !== 0xff || (pending[1] & 0xf0) !== 0xf0) {
          const sync = pending.indexOf(0xff, 1);
          if (sync < 0) {
            pending = Buffer.alloc(0);
            break;
          }
          pending = pending.subarray(sync);
          continue;
        }
        const len =
          ((pending[3] & 0x03) << 11) | (pending[4] << 3) | (pending[5] >> 5);
        if (len < 7 || pending.length < len) break;
        const frame = pending.subarray(0, len);
        pending = pending.subarray(len);
        let open = 0;
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(frame);
            open += 1;
          }
        }
        framesOut += 1;
        if (!loggedFirst && open) {
          loggedFirst = true;
          console.log(
            `[talkback] live: first ADTS frame → ${open} speaker socket(s)`,
          );
        }
      }
    });
    ff.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      console.log(
        `[talkback] live ffmpeg closed code=${code} frames=${framesOut} stderr=${stderr.slice(0, 120) || "ok"}`,
      );
      if (signal.aborted) resolve();
      else if (code === 0 || code === null) resolve();
      else reject(new Error(`live ffmpeg failed (${code}): ${stderr.slice(0, 300)}`));
    });
    ff.on("error", reject);
  });
}

async function runLiveTalkbackSession(input: {
  speakerIds: string[];
  pcmReadable: NodeJS.ReadableStream;
  pcmSampleRate: number;
  signal: AbortSignal;
}): Promise<void> {
  const { cookie } = await getProtectAuthHeaders();
  const sockets = await openTalkbackSockets(
    input.speakerIds,
    cookie,
    input.signal,
  );
  if (!sockets.length) return;
  try {
    await streamLiveAdts(
      input.pcmReadable,
      sockets,
      input.signal,
      input.pcmSampleRate,
    );
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
  file?: string;
  /** Multiple files played as one continuous talkback (preferred for tone→clip). */
  files?: string[];
  speakerIds: string[];
  loop?: boolean;
  repeat?: number;
  gapMs?: number;
  /** Wait until the clip finishes (sequences, PA preamble). Default: return after arm. */
  awaitDone?: boolean;
}): Promise<void> {
  if (playbackPromise) {
    stopTalkback();
    try {
      await playbackPromise;
    } catch {
      /* prior session aborted */
    }
    await sleep(POST_STOP_SETTLE_MS);
  }

  const bases = (input.files?.length ? input.files : input.file ? [input.file] : [])
    .map((f) => resolveAudioFile(f));
  if (!bases.length) throw new Error("talkback file(s) required");
  for (const fp of bases) await readFile(fp);

  const repeat = input.loop ? 1 : Math.max(1, input.repeat ?? 1);
  const filePaths: string[] = [];
  if (input.loop) {
    filePaths.push(bases[0]);
  } else {
    for (let r = 0; r < repeat; r++) {
      for (const fp of bases) filePaths.push(fp);
    }
  }

  const controller = new AbortController();
  abortController = controller;
  state.active = true;
  state.actionId = input.actionId;
  state.loop = Boolean(input.loop);
  state.repeat = input.loop ? 0 : repeat;
  state.startedAt = Date.now();

  playbackPromise = runTalkbackSession({
    filePaths,
    gapMs: input.gapMs,
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
        state.repeat = 1;
        state.startedAt = null;
      }
    });

  // Let the session arm before returning — reduces clipped starts.
  await sleep(ARM_MS + 50);
  if (input.awaitDone) {
    await playbackPromise;
  }
}

/** Live mic/SIP PCM → Protect talkback (convenience PA). */
export async function startLiveTalkback(input: {
  actionId?: string;
  speakerIds: string[];
  pcmReadable: NodeJS.ReadableStream;
  /** Asterisk AudioSocket default is 8000. */
  pcmSampleRate?: number;
  /** Wait until the live stream ends (hangup / abort). */
  awaitDone?: boolean;
}): Promise<void> {
  if (!input.speakerIds.length) {
    throw new Error("PA speakerIds required");
  }
  if (playbackPromise) {
    stopTalkback();
    try {
      await playbackPromise;
    } catch {
      /* prior session aborted */
    }
    await sleep(POST_STOP_SETTLE_MS);
  }

  const controller = new AbortController();
  abortController = controller;
  state.active = true;
  state.actionId = input.actionId || "pa.live";
  state.loop = false;
  state.repeat = 1;
  state.startedAt = Date.now();

  playbackPromise = runLiveTalkbackSession({
    speakerIds: input.speakerIds,
    pcmReadable: input.pcmReadable,
    pcmSampleRate: input.pcmSampleRate ?? 8000,
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
        state.repeat = 1;
        state.startedAt = null;
      }
    });

  if (input.awaitDone) {
    await playbackPromise;
  } else {
    await sleep(ARM_MS + 50);
  }
}

export async function waitForTalkbackIdle(): Promise<void> {
  if (playbackPromise) await playbackPromise;
}
