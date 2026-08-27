import { SignJWT, jwtVerify } from "jose";
import {
  PLAY_TOKEN_TTL_SEC,
  SESSION_MAX_AGE_SEC,
  type Env,
  type Scope,
  type SessionPayload,
} from "./types";

function enc(s: string) {
  return new TextEncoder().encode(s);
}

export async function signSession(env: Env, payload: SessionPayload): Promise<string> {
  return new SignJWT({
    pinId: payload.pinId,
    label: payload.label,
    scopes: payload.scopes,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(enc(env.SESSION_SECRET));
}

export type VerifiedSession = SessionPayload & { expiresAt: number };

export async function verifySession(
  env: Env,
  token: string,
): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(token, enc(env.SESSION_SECRET));
    if (!payload.pinId || !payload.label) return null;
    const exp = typeof payload.exp === "number" ? payload.exp * 1000 : Date.now();
    return {
      pinId: String(payload.pinId),
      label: String(payload.label),
      scopes: (payload.scopes as Scope[]) ?? [],
      expiresAt: exp,
    };
  } catch {
    return null;
  }
}

export async function signPlayToken(
  env: Env,
  input: { pinId: string; scopes: Scope[]; actionId: string },
): Promise<string> {
  return new SignJWT({
    pinId: input.pinId,
    scopes: input.scopes,
    actionId: input.actionId,
    typ: "play",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PLAY_TOKEN_TTL_SEC}s`)
    .sign(enc(env.PLAY_JWT_SECRET));
}
