/** Speaker-check desk phone notify — report types and cloud sync. */

export type TestNotifyExtOutcome =
  | "pending"
  | "ringing"
  | "answered"
  | "playing_prompt"
  | "delayed"
  | "acknowledged"
  | "no_answer"
  | "failed";

export type TestNotifyExtReport = {
  ext: string;
  label: string;
  status: TestNotifyExtOutcome;
  error?: string;
  digit?: string | null;
  ringStartedAt: number;
  answeredAt?: number;
  finishedAt?: number;
};

export type TestNotifyReport = {
  id: string;
  state: "ringing" | "complete";
  startedAt: number;
  finishedAt?: number;
  requestedBy?: string;
  playId?: string;
  notifyOnly: boolean;
  delayMinutes: number;
  delayed: boolean;
  delayedBy: string[];
  hornsAt?: number | null;
  extensions: TestNotifyExtReport[];
};

let latestReport: TestNotifyReport | null = null;

export function getLatestTestNotifyReport(): TestNotifyReport | null {
  return latestReport;
}

export function createTestNotifyReport(meta: {
  exts: string[];
  labels: Record<string, string>;
  requestedBy?: string;
  playId?: string;
  notifyOnly: boolean;
  delayMinutes: number;
}): TestNotifyReport {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    state: "ringing",
    startedAt: now,
    requestedBy: meta.requestedBy,
    playId: meta.playId,
    notifyOnly: meta.notifyOnly,
    delayMinutes: meta.delayMinutes,
    delayed: false,
    delayedBy: [],
    hornsAt: null,
    extensions: meta.exts.map((ext) => ({
      ext,
      label: meta.labels[ext] || ext,
      status: "ringing",
      ringStartedAt: now,
    })),
  };
}

export function patchExtReport(
  report: TestNotifyReport,
  ext: string,
  patch: Partial<TestNotifyExtReport>,
): TestNotifyExtReport | undefined {
  const row = report.extensions.find((e) => e.ext === ext);
  if (!row) return undefined;
  Object.assign(row, patch);
  return row;
}

const REPORT_URL = () =>
  (
    process.env.CLOUD_TEST_NOTIFY_URL ||
    (process.env.CLOUD_POLL_URL || "https://alarm.arnoldcoc.org/api/gateway/poll").replace(
      /\/api\/gateway\/poll\/?$/,
      "/api/gateway/test-notify",
    )
  ).trim();

export async function publishTestNotifyReport(report: TestNotifyReport): Promise<void> {
  latestReport = report;
  const secret = process.env.GATEWAY_POLL_SECRET || "";
  if (!secret) return;
  try {
    await fetch(REPORT_URL(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(report),
    });
  } catch (err) {
    console.warn(
      "[test-notify] cloud report failed",
      err instanceof Error ? err.message : err,
    );
  }
}
