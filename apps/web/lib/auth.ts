import { SignJWT, jwtVerify } from "jose";
import {
  PLAY_TOKEN_TTL_SEC,
  SESSION_MAX_AGE_SEC,
  type Scope,
  type SessionPayload,
} from "./types";

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(s);
}

function playSecret() {
  const s = process.env.PLAY_JWT_SECRET;
  if (!s) throw new Error("PLAY_JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({
    pinId: payload.pinId,
    label: payload.label,
    scopes: payload.scopes,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(sessionSecret());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    const scopes = (payload.scopes as Scope[]) ?? [];
    if (!payload.pinId || !payload.label) return null;
    return {
      pinId: String(payload.pinId),
      label: String(payload.label),
      scopes,
    };
  } catch {
    return null;
  }
}

export async function signPlayToken(input: {
  pinId: string;
  scopes: Scope[];
  actionId: string;
}): Promise<string> {
  return new SignJWT({
    pinId: input.pinId,
    scopes: input.scopes,
    actionId: input.actionId,
    typ: "play",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PLAY_TOKEN_TTL_SEC}s`)
    .sign(playSecret());
}
