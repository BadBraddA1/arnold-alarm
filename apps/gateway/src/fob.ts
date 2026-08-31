/**
 * Physical fob / Alarm Manager webhook → local talkback play.
 * Bypasses arm hold (emergency backup when staff cannot reach a phone).
 */
import { playLocalAction } from "./play-local.js";

const DEFAULT_MAP: Record<string, string> = {
  red: "evacuate.code_red",
  code_red: "evacuate.code_red",
  "code-red": "evacuate.code_red",
  blue: "evacuate.code_blue",
  code_blue: "evacuate.code_blue",
  "code-blue": "evacuate.code_blue",
  clear: "__all_clear__",
  green: "__all_clear__",
  all_clear: "__all_clear__",
  "all-clear": "__all_clear__",
};

function fobSecret(): string {
  return (process.env.FOB_WEBHOOK_SECRET || process.env.GATEWAY_POLL_SECRET || "").trim();
}

function loadMap(): Record<string, string> {
  const base = { ...DEFAULT_MAP };
  try {
    const extra = JSON.parse(process.env.FOB_MAP || "{}") as Record<string, string>;
    for (const [k, v] of Object.entries(extra)) {
      if (k && v) base[k.toLowerCase()] = v;
    }
  } catch {
    console.warn("[fob] invalid FOB_MAP JSON — using defaults");
  }
  return base;
}

export function getFobStatus(): {
  enabled: boolean;
  codes: string[];
  bypassArm: boolean;
} {
  const enabled = Boolean(fobSecret());
  const map = loadMap();
  const codes = [...new Set(Object.keys(map))].sort();
  return {
    enabled,
    codes,
    bypassArm: process.env.FOB_BYPASS_ARM !== "0",
  };
}

function cloudFobUrl(): string {
  return (
    process.env.CLOUD_FOB_URL ||
    (process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll").replace(
      /\/api\/gateway\/poll\/?$/,
      "/api/gateway/fob",
    )
  );
}

async function reportFobToCloud(input: {
  id: string;
  code: string;
  actionId: string;
  label: string;
  ok: boolean;
  error?: string;
}): Promise<void> {
  const secret = process.env.GATEWAY_POLL_SECRET || "";
  if (!secret) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    await fetch(cloudFobUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.warn(
      "[fob] cloud audit failed (local play still ran)",
      err instanceof Error ? err.message : err,
    );
  }
}

function normalizeCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function extractAuth(reqUrl: URL, headers: IncomingMessageHeaders): string | null {
  const fromQuery = reqUrl.searchParams.get("secret") || reqUrl.searchParams.get("token");
  if (fromQuery) return fromQuery.trim();
  const auth = headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = headers["x-fob-secret"];
  if (typeof header === "string") return header.trim();
  return null;
}

type IncomingMessageHeaders = {
  authorization?: string;
  "x-fob-secret"?: string;
};

export type FobTriggerInput = {
  code: string;
  label?: string;
  secret?: string;
  source?: string;
};

export async function handleFobTrigger(
  input: FobTriggerInput,
  headers: IncomingMessageHeaders = {},
  reqUrl?: URL,
): Promise<{ ok: true; actionId: string; id: string } | { ok: false; status: number; error: string }> {
  const expected = fobSecret();
  if (!expected) {
    return { ok: false, status: 503, error: "FOB_WEBHOOK_SECRET not configured" };
  }

  const provided =
    input.secret?.trim() ||
    (reqUrl ? extractAuth(reqUrl, headers) : null) ||
    headers["x-fob-secret"]?.trim();
  if (!provided || provided !== expected) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const code = normalizeCode(input.code);
  if (!code) {
    return { ok: false, status: 400, error: "code required (red, blue, clear)" };
  }

  const map = loadMap();
  const actionId = map[code];
  if (!actionId) {
    return {
      ok: false,
      status: 404,
      error: `Unknown fob code: ${code}. Known: ${Object.keys(map).sort().join(", ")}`,
    };
  }

  const id = crypto.randomUUID();
  const label = (input.label || input.source || `Fob · ${code}`).trim().slice(0, 120);

  void (async () => {
    try {
      await playLocalAction(actionId);
      console.log(`[fob] ${code} → ${actionId} (${label})`);
      await reportFobToCloud({ id, code, actionId, label, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Fob play failed";
      console.error(`[fob] ${code} failed`, message);
      await reportFobToCloud({ id, code, actionId, label, ok: false, error: message });
    }
  })();

  return { ok: true, actionId, id };
}
