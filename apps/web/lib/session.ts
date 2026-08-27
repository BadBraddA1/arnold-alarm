import { cookies } from "next/headers";
import { verifySession } from "./auth";
import { SESSION_COOKIE, type SessionPayload } from "./types";

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}
