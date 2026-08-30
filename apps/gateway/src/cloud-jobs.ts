import { setVolumeProfile } from "./protect.js";
import { stopTalkback } from "./talkback.js";

export type CloudJob = {
  id: string;
  actionId: string;
  delayMinutes: number;
  label: string;
  loop?: boolean;
  command?: "play" | "stop" | "all_clear";
};

export type CloudJobHandlers = {
  runAction: (
    actionId: string,
    options?: { loop?: boolean },
  ) => Promise<void>;
  scheduleJob: (actionId: string, delayMs: number, id?: string) => {
    id: string;
    actionId: string;
    fireAt: number;
  };
  ackCloud: (id: string, ok: boolean, error?: string) => Promise<void>;
  cancelLocalSchedule: (id: string) => boolean;
};

export async function handleCloudJob(
  job: CloudJob,
  volumes: { bells?: number; evac?: number } | undefined,
  handlers: CloudJobHandlers,
): Promise<void> {
  if (volumes) {
    setVolumeProfile(volumes);
  }

  console.log(
    `[job] ${job.id} ${job.command || "play"} ${job.actionId} delay=${job.delayMinutes} from ${job.label}`,
  );

  try {
    if (job.command === "stop") {
      stopTalkback();
      await handlers.ackCloud(job.id, true);
      return;
    }
    if (job.command === "all_clear" || job.actionId === "__all_clear__") {
      await handlers.runAction("__all_clear__");
      await handlers.ackCloud(job.id, true);
      return;
    }
    if (job.delayMinutes > 0) {
      handlers.scheduleJob(job.actionId, job.delayMinutes * 60_000, job.id);
      await handlers.ackCloud(job.id, true);
      return;
    }
    await handlers.runAction(job.actionId, { loop: job.loop });
    console.log(`[job] ok ${job.id} ${job.actionId}`);
    await handlers.ackCloud(job.id, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    console.error(`[job] failed ${job.id}`, message);
    await handlers.ackCloud(job.id, false, message);
  }
}
