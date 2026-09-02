export type Scope = "bells" | "evacuate" | "admin" | "remote";

export type SessionPayload = {
  pinId: string;
  label: string;
  scopes: Scope[];
  /** True until the user replaces a temp PIN with their own. */
  mustChangePin?: boolean;
};

export const SESSION_COOKIE = "arnold_alarm_session";
/** Staff shift window — app + fob lease use the same 3-hour window. */
export const SESSION_MAX_AGE_SEC = 3 * 60 * 60;
export const PLAY_TOKEN_TTL_SEC = 60;
/** Client idle auto-sign-out (must be ≤ SESSION_MAX_AGE_SEC). */
export const SESSION_IDLE_SEC = 3 * 60 * 60;
export const FOB_LEASE_SEC = 3 * 60 * 60;

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  PLAY_JWT_SECRET: string;
  GATEWAY_POLL_SECRET: string;
  /** Shared with emergency.arnoldcoc.org Pages Functions — PIN verify only (not gateway). */
  EMERGENCY_VERIFY_SECRET?: string;
  GATEWAY_URL: string;
  BELL_ACTIONS: string;
  EVACUATE_ACTIONS: string;
  /** Optional — live arm/activity sync across devices */
  ABLY_API_KEY?: string;
};

/** Page access: admin implies bells/evacuate. Remote is never implied — must be granted. */
export function hasScope(scopes: Scope[], needed: Scope): boolean {
  if (needed === "remote") return scopes.includes("remote");
  if (scopes.includes("admin")) return true;
  return scopes.includes(needed);
}

export function normalizeScopes(raw: string[]): Scope[] {
  const allowed = new Set<Scope>(["bells", "evacuate", "admin", "remote"]);
  const out = new Set<Scope>();
  for (const s of raw) {
    if (s === "both") {
      out.add("bells");
      out.add("evacuate");
      continue;
    }
    if (allowed.has(s as Scope)) out.add(s as Scope);
  }
  return [...out];
}

export type ActionDef = { id: string; label: string };

export function parseActionList(raw: string | undefined): ActionDef[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((part) => {
      const [id, ...rest] = part.trim().split(":");
      return { id: id.trim(), label: (rest.join(":") || id).trim() };
    })
    .filter((a) => a.id);
}

export function actionAllowed(actionId: string, scopes: Scope[]): boolean {
  // All clear only via Stop & All Clear — not a standalone play button.
  if (actionId === "evacuate.code_green") return false;
  if (actionId === "__stop__") {
    return hasScope(scopes, "evacuate") || hasScope(scopes, "admin");
  }
  if (actionId === "__all_clear__") return hasScope(scopes, "evacuate");
  if (actionId === "test.speakers") {
    return hasScope(scopes, "bells") || hasScope(scopes, "evacuate") || hasScope(scopes, "admin");
  }
  // Single-speaker tone from Admin campus list
  if (actionId.startsWith("test.speaker:")) {
    return hasScope(scopes, "admin");
  }
  if (actionId.startsWith("test.phone:")) {
    return hasScope(scopes, "admin");
  }
  if (scopes.includes("admin")) return true;
  if (actionId.startsWith("bells.") && hasScope(scopes, "bells")) return true;
  if (actionId.startsWith("evacuate.") && hasScope(scopes, "evacuate")) return true;
  return false;
}

/** Code Red / Blue (and main) loop on speakers until Stop & All clear. */
export function loopsUntilAllClear(actionId: string): boolean {
  return (
    actionId === "evacuate.code_red" ||
    actionId === "evacuate.code_blue" ||
    actionId === "evacuate.main"
  );
}

/** Explicit false wins; otherwise emergency codes default to looping. */
export function resolvePlayLoop(
  actionId: string,
  loop: boolean | undefined,
): boolean {
  if (typeof loop === "boolean") return loop;
  return loopsUntilAllClear(actionId);
}

export type EvacAudioMode = "loop" | "once" | "repeat";

/** How campus horns behave after Code Red / Blue is declared. */
export function resolveEvacAudio(
  actionId: string,
  input: {
    evacAudio?: EvacAudioMode;
    loop?: boolean;
    repeatMinutes?: number;
  },
): { loop: boolean; repeatMinutes: number | null } {
  if (!loopsUntilAllClear(actionId)) {
    return { loop: resolvePlayLoop(actionId, input.loop), repeatMinutes: null };
  }
  let mode: EvacAudioMode = "loop";
  if (input.evacAudio === "once" || input.evacAudio === "repeat" || input.evacAudio === "loop") {
    mode = input.evacAudio;
  } else if (input.loop === false) {
    mode = "once";
  }
  if (mode === "loop") return { loop: true, repeatMinutes: null };
  if (mode === "once") return { loop: false, repeatMinutes: null };
  const mins = Math.max(1, Math.min(60, Math.round(Number(input.repeatMinutes) || 2)));
  return { loop: false, repeatMinutes: mins };
}
