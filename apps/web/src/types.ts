export type Scope = "bells" | "evacuate" | "admin";

export type SessionPayload = {
  pinId: string;
  label: string;
  scopes: Scope[];
};

export const SESSION_COOKIE = "arnold_alarm_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 12;
export const PLAY_TOKEN_TTL_SEC = 60;

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  PLAY_JWT_SECRET: string;
  GATEWAY_URL: string;
  BELL_ACTIONS: string;
  EVACUATE_ACTION: string;
};

export function hasScope(scopes: Scope[], needed: Scope): boolean {
  if (scopes.includes("admin")) return true;
  return scopes.includes(needed);
}

export function normalizeScopes(raw: string[]): Scope[] {
  const allowed = new Set<Scope>(["bells", "evacuate", "admin"]);
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
