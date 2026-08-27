import Ably from "ably";
import type { Env } from "./types";

/** Shared campus dashboard channel — arm state + activity hints. */
export const SYSTEM_CHANNEL = "arnold-alarm:system";

function getRest(env: Env): Ably.Rest | null {
  const key = env.ABLY_API_KEY?.trim();
  if (!key) return null;
  return new Ably.Rest({ key });
}

export async function createSystemTokenRequest(
  env: Env,
  clientId: string,
): Promise<Ably.TokenRequest> {
  const rest = getRest(env);
  if (!rest) throw new Error("ABLY_API_KEY not configured");
  return rest.auth.createTokenRequest({
    clientId: clientId.slice(0, 64) || "staff",
    capability: {
      [SYSTEM_CHANNEL]: ["subscribe"],
    },
  });
}

export async function publishSystemEvent(
  env: Env,
  name: "armed" | "activity",
  data: Record<string, unknown>,
): Promise<void> {
  const rest = getRest(env);
  if (!rest) return;
  try {
    await rest.channels.get(SYSTEM_CHANNEL).publish(name, data);
  } catch (err) {
    console.error("[ably] publish failed", name, err);
  }
}
