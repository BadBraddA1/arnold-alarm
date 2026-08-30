import Ably from "ably";
import type { Env } from "./types";

/** Shared campus dashboard channel — arm state + activity hints. */
export const SYSTEM_CHANNEL = "arnold-alarm:system";
/** Push remote play jobs to the campus gateway (Pi subscribes). */
export const GATEWAY_CHANNEL = "arnold-alarm:gateway";

export type GatewayJobMessage = {
  type: "play";
  id: string;
  actionId: string;
  delayMinutes: number;
  label: string;
  loop?: boolean;
  command?: "play" | "stop" | "all_clear";
  volumes?: { bells?: number; evac?: number; bellsBySpeaker?: Record<string, number> };
};

export type GatewayCancelMessage = {
  type: "cancel";
  id: string;
};

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

export async function createGatewayTokenRequest(
  env: Env,
  clientId: string,
): Promise<Ably.TokenRequest> {
  const rest = getRest(env);
  if (!rest) throw new Error("ABLY_API_KEY not configured");
  return rest.auth.createTokenRequest({
    clientId: clientId.slice(0, 64) || "gateway",
    capability: {
      [GATEWAY_CHANNEL]: ["subscribe"],
    },
  });
}

export async function publishSystemEvent(
  env: Env,
  name: "armed" | "activity" | "evac",
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

export async function publishGatewayJob(
  env: Env,
  job: GatewayJobMessage,
): Promise<void> {
  const rest = getRest(env);
  if (!rest) return;
  try {
    await rest.channels.get(GATEWAY_CHANNEL).publish("job", job);
  } catch (err) {
    console.error("[ably] gateway job publish failed", job.id, err);
  }
}

export async function publishGatewayCancel(
  env: Env,
  id: string,
): Promise<void> {
  const rest = getRest(env);
  if (!rest) return;
  try {
    await rest.channels.get(GATEWAY_CHANNEL).publish("cancel", { type: "cancel", id });
  } catch (err) {
    console.error("[ably] gateway cancel publish failed", id, err);
  }
}
