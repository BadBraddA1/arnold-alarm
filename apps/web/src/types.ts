export type Scope = "bells" | "evacuate" | "admin" | "remote";

export type SessionPayload = {
  pinId: string;
  label: string;
  scopes: Scope[];
};

export const SESSION_COOKIE = "arnold_alarm_session";
/** Short TTL so a phone left unlocked does not stay armed all day. */
export const SESSION_MAX_AGE_SEC = 45 * 60;
export const PLAY_TOKEN_TTL_SEC = 60;
/** Client idle auto-sign-out (must be ≤ SESSION_MAX_AGE_SEC). */
export const SESSION_IDLE_SEC = 30 * 60;

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  PLAY_JWT_SECRET: string;
  GATEWAY_POLL_SECRET: string;
  GATEWAY_URL: string;
  BELL_ACTIONS: string;
  EVACUATE_ACTIONS: string;
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
  if (actionId === "__all_clear__") return hasScope(scopes, "evacuate");
  if (actionId === "test.speakers") {
    return hasScope(scopes, "bells") || hasScope(scopes, "evacuate");
  }
  if (scopes.includes("admin")) return true;
  if (actionId.startsWith("bells.") && hasScope(scopes, "bells")) return true;
  if (actionId.startsWith("evacuate.") && hasScope(scopes, "evacuate")) return true;
  return false;
}
