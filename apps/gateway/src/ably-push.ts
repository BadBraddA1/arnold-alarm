import Ably from "ably";
import { handleCloudJob, type CloudJobHandlers } from "./cloud-jobs.js";

const ABLY_TOKEN_URL =
  process.env.CLOUD_ABLY_TOKEN_URL ||
  "https://alarm.arnoldcoc.org/api/gateway/ably-token";
const POLL_SECRET = process.env.GATEWAY_POLL_SECRET || "";
const ABLY_ENABLED = process.env.CLOUD_ABLY_PUSH !== "0";

let realtime: Ably.Realtime | null = null;

async function fetchTokenRequest(): Promise<{
  tokenRequest: Ably.TokenRequest;
  channel: string;
}> {
  const res = await fetch(ABLY_TOKEN_URL, {
    headers: { Authorization: `Bearer ${POLL_SECRET}` },
  });
  if (!res.ok) {
    throw new Error(`ably token http ${res.status}`);
  }
  const data = (await res.json()) as {
    tokenRequest?: Ably.TokenRequest;
    channel?: string;
  };
  if (!data.tokenRequest) throw new Error("ably token missing");
  return {
    tokenRequest: data.tokenRequest,
    channel: data.channel || "arnold-alarm:gateway",
  };
}

export function startAblyPush(handlers: CloudJobHandlers) {
  if (!ABLY_ENABLED || !POLL_SECRET) {
    console.log("[ably] push disabled (set GATEWAY_POLL_SECRET; CLOUD_ABLY_PUSH=0 to opt out)");
    return;
  }

  const connect = () => {
    if (realtime) {
      try {
        realtime.close();
      } catch {
        /* ignore */
      }
    }

    realtime = new Ably.Realtime({
      authCallback: (_params, callback) => {
        fetchTokenRequest()
          .then(({ tokenRequest }) => callback(null, tokenRequest))
          .catch((err) =>
            callback(err instanceof Error ? err.message : "token failed", null),
          );
      },
      clientId: "gateway-primary",
    });

    realtime.connection.on("connected", async () => {
      try {
        const { channel: channelName } = await fetchTokenRequest();
        const channel = realtime!.channels.get(channelName);
        channel.subscribe("job", (msg) => {
          const job = msg.data as {
            type?: string;
            id?: string;
            actionId?: string;
            delayMinutes?: number;
            label?: string;
            loop?: boolean;
            command?: "play" | "stop" | "all_clear";
            volumes?: { bells?: number; evac?: number };
          };
          if (!job?.id || !job.actionId) return;
          void handleCloudJob(
            {
              id: job.id,
              actionId: job.actionId,
              delayMinutes: Number(job.delayMinutes) || 0,
              label: job.label || "remote",
              loop: job.loop,
              command: job.command,
            },
            job.volumes,
            handlers,
          );
        });
        channel.subscribe("cancel", (msg) => {
          const data = msg.data as { id?: string };
          if (!data?.id) return;
          const cancelled = handlers.cancelLocalSchedule(data.id);
          console.log(`[ably] cancel ${data.id} local=${cancelled}`);
        });
        console.log(`[ably] subscribed → ${channelName}`);
      } catch (err) {
        console.error("[ably] subscribe failed", err);
      }
    });

    realtime.connection.on("failed", (state) => {
      console.error("[ably] connection failed", state.reason?.message || state);
    });
  };

  connect();
  setInterval(() => {
    if (realtime?.connection.state === "failed") {
      console.warn("[ably] reconnecting…");
      connect();
    }
  }, 30_000);
}
