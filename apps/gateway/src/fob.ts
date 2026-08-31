/**
 * Physical fob / Alarm Manager webhook → lease check → local talkback play.
 * Staff must arm their assigned fob (app or phone IVR 4) — 3-hour window.
 */
import { playLocalAction } from "./play-local.js";

const DEFAULT_MAP: Record<string, string> = {
  red: "evacuate.code_red",
  code_red: "evacuate.code_red",
  blue: "evacuate.code_blue",
  code_blue: "evacuate.code_blue",
  clear: "__all_clear__",
  green: "__all_clear__",
  all_clear: "__all_clear__",
};

function fobSecret(): string {
  return (process.env.FOB_WEBHOOK_SECRET || process.env.GATEWAY_POLL_SECRET || "").trim();
}

function requireLease(): boolean {
  return process.env.FOB_REQUIRE_LEASE !== "0";
}

function cloudBase(): string {
  return (
    process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll"
  ).replace(/\/api\/gateway\/poll\/?$/, "");
}

function cloudFobReportUrl(): string {
  return process.env.CLOUD_FOB_URL || `${cloudBase()}/api/gateway/fob`;
}

function cloudFobAuthorizeUrl(): string {
  return (
    process.env.CLOUD_FOB_AUTH_URL || `${cloudBase()}/api/gateway/fob/authorize`
  );
}

export function getFobStatus(): {
  enabled: boolean;
  requireLease: boolean;
  codes: string[];
} {
  return {
    enabled: Boolean(fobSecret()),
    requireLease: requireLease(),
    codes: Object.keys(DEFAULT_MAP).sort(),
  };
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
  fobId: string;
  code: string;
  label?: string;
  secret?: string;
};

type AuthorizeResult =
  | {
      allowed: true;
      actionId: string;
      label: string;
      pinId: string;
      fobName: string;
    }
  | { allowed: false; error: string };

async function authorizeWithCloud(
  fobId: string,
  code: string,
): Promise<AuthorizeResult> {
  const secret = process.env.GATEWAY_POLL_SECRET || "";
  if (!secret) {
    return { allowed: false, error: "Gateway cloud secret not configured" };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(cloudFobAuthorizeUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fobId, code }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = (await res.json().catch(() => ({}))) as AuthorizeResult & {
      error?: string;
    };
    if (!res.ok || !data.allowed) {
      return { allowed: false, error: data.error || `authorize failed (${res.status})` };
    }
    return data;
  } catch (err) {
    return {
      allowed: false,
      error: err instanceof Error ? err.message : "authorize network error",
    };
  }
}

async function reportFobToCloud(input: {
  id: string;
  fobId: string;
  code: string;
  actionId: string;
  label: string;
  pinId?: string;
  ok?: boolean;
  rejected?: boolean;
  error?: string;
}): Promise<void> {
  const secret = process.env.GATEWAY_POLL_SECRET || "";
  if (!secret) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    await fetch(cloudFobReportUrl(), {
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
      "[fob] cloud audit failed",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function handleFobTrigger(
  input: FobTriggerInput,
  headers: IncomingMessageHeaders = {},
  reqUrl?: URL,
): Promise<
  | { ok: true; actionId: string; id: string; armed: true }
  | { ok: true; id: string; armed: false; error: string }
  | { ok: false; status: number; error: string }
> {
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

  const fobId = input.fobId.trim().toLowerCase();
  const code = input.code.trim().toLowerCase().replace(/\s+/g, "_");
  if (!fobId) return { ok: false, status: 400, error: "fob id required" };
  if (!code) return { ok: false, status: 400, error: "code required (red, blue, clear)" };
  if (!DEFAULT_MAP[code]) {
    return { ok: false, status: 404, error: `Unknown code: ${code}` };
  }

  const id = crypto.randomUUID();

  if (requireLease()) {
    const auth = await authorizeWithCloud(fobId, code);
    if (!auth.allowed) {
      console.warn(`[fob] rejected ${fobId}/${code}: ${auth.error}`);
      void reportFobToCloud({
        id,
        fobId,
        code,
        actionId: DEFAULT_MAP[code],
        label: input.label || fobId,
        rejected: true,
        error: auth.error,
      });
      return { ok: true, id, armed: false, error: auth.error };
    }

    void (async () => {
      try {
        await playLocalAction(auth.actionId);
        console.log(`[fob] ${fobId}/${code} → ${auth.actionId} (${auth.label})`);
        await reportFobToCloud({
          id,
          fobId,
          code,
          actionId: auth.actionId,
          label: auth.label,
          pinId: auth.pinId,
          ok: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Fob play failed";
        console.error(`[fob] play failed`, message);
        await reportFobToCloud({
          id,
          fobId,
          code,
          actionId: auth.actionId,
          label: auth.label,
          pinId: auth.pinId,
          ok: false,
          error: message,
        });
      }
    })();

    return { ok: true, actionId: auth.actionId, id, armed: true };
  }

  const actionId = DEFAULT_MAP[code];
  const label = input.label || `Fob · ${fobId}`;
  void (async () => {
    try {
      await playLocalAction(actionId);
      await reportFobToCloud({
        id,
        fobId,
        code,
        actionId,
        label,
        ok: true,
      });
    } catch (err) {
      await reportFobToCloud({
        id,
        fobId,
        code,
        actionId,
        label,
        ok: false,
        error: err instanceof Error ? err.message : "play failed",
      });
    }
  })();
  return { ok: true, actionId, id, armed: true };
}

/** Parse /fob/{fobId}/{code} or legacy /fob/{code} with ?fob= */
export function parseFobPath(pathname: string, searchParams: URLSearchParams): {
  fobId: string;
  code: string;
} | null {
  if (!pathname.startsWith("/fob/")) return null;
  const rest = decodeURIComponent(pathname.slice("/fob/".length));
  const parts = rest.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return { fobId: parts[0], code: parts[1] };
  }
  if (parts.length === 1) {
    const fobId = searchParams.get("fob")?.trim();
    if (fobId) return { fobId, code: parts[0] };
  }
  return null;
}
