"use client";

import { useCallback, useEffect, useState } from "react";

type Job = { id: string; actionId: string; fireAt: number };

type Props = {
  actionId: string;
  actionLabel: string;
  delayMinutes?: number;
};

export function ScheduleBellButton({
  actionId,
  actionLabel,
  delayMinutes = 15,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [jobs, setJobs] = useState<Job[]>([]);
  const [now, setNow] = useState(Date.now());
  const gatewayUrl =
    process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://alarm-gw.local:8787";

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch(`${gatewayUrl}/schedule`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { jobs: Job[] };
      setJobs(data.jobs.filter((j) => j.actionId === actionId || true));
    } catch {
      /* offline LAN */
    }
  }, [gatewayUrl, actionId]);

  useEffect(() => {
    void refreshJobs();
    const id = setInterval(() => {
      setNow(Date.now());
      void refreshJobs();
    }, 2000);
    return () => clearInterval(id);
  }, [refreshJobs]);

  async function schedule() {
    setBusy(true);
    setMessage(null);
    try {
      const tokenRes = await fetch("/api/play-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId }),
      });
      const tokenData = (await tokenRes.json()) as {
        error?: string;
        token?: string;
        gatewayUrl?: string;
      };
      if (!tokenRes.ok || !tokenData.token || !tokenData.gatewayUrl) {
        setMessage({ kind: "err", text: tokenData.error ?? "Could not authorize." });
        return;
      }

      let res: Response;
      try {
        res = await fetch(`${tokenData.gatewayUrl}/schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId,
            token: tokenData.token,
            delayMinutes,
          }),
        });
      } catch {
        setMessage({
          kind: "err",
          text: "Cannot reach the alarm gateway. Join church Wi‑Fi to schedule.",
        });
        return;
      }

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        job?: Job;
      };
      if (!res.ok) {
        setMessage({ kind: "err", text: data.error ?? "Schedule failed." });
        return;
      }
      setMessage({
        kind: "ok",
        text: `${actionLabel} scheduled in ${delayMinutes} min. Safe to close this page — the Pi will ring it.`,
      });
      await refreshJobs();
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await fetch(`${gatewayUrl}/schedule/${id}`, { method: "DELETE" });
      await refreshJobs();
      setMessage({ kind: "ok", text: "Cancelled." });
    } catch {
      setMessage({
        kind: "err",
        text: "Could not cancel — are you on church Wi‑Fi?",
      });
    }
  }

  const pending = jobs.filter((j) => j.fireAt > now);

  return (
    <div className="stack">
      <button
        type="button"
        className="btn btn-ghost btn-block"
        disabled={busy}
        onClick={() => void schedule()}
      >
        {busy ? "Scheduling…" : `Ring “${actionLabel}” in ${delayMinutes} min`}
      </button>
      {pending.length > 0 ? (
        <div className="card stack" style={{ padding: "0.9rem 1rem" }}>
          <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
            Scheduled on gateway
          </p>
          {pending.map((j) => {
            const secs = Math.max(0, Math.round((j.fireAt - now) / 1000));
            const m = Math.floor(secs / 60);
            const s = secs % 60;
            return (
              <div
                key={j.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.75rem",
                }}
              >
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {j.actionId} · {m}:{String(s).padStart(2, "0")}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ minHeight: "2.25rem", padding: "0.35rem 0.7rem" }}
                  onClick={() => void cancel(j.id)}
                >
                  Cancel
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {message ? (
        <div className={message.kind === "ok" ? "success-banner" : "error-banner"}>
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
