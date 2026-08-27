"use client";

import { useState } from "react";

type Props = {
  actionId: string;
  label: string;
  variant?: "primary" | "danger";
  confirmLabel?: string;
};

export function PlayButton({
  actionId,
  label,
  variant = "primary",
  confirmLabel,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [armed, setArmed] = useState(!confirmLabel);

  async function play() {
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
        setMessage({
          kind: "err",
          text: tokenData.error ?? "Could not authorize play.",
        });
        return;
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let playRes: Response;
      try {
        playRes = await fetch(`${tokenData.gatewayUrl}/play`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionId, token: tokenData.token }),
          signal: ctrl.signal,
        });
      } catch {
        setMessage({
          kind: "err",
          text: "Cannot reach the alarm gateway. Join the church Wi‑Fi network and try again. The site works on cellular, but play must go through the Pi on campus.",
        });
        return;
      } finally {
        clearTimeout(timer);
      }

      const playData = (await playRes.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
      };
      if (!playRes.ok) {
        setMessage({
          kind: "err",
          text: playData.error ?? `Gateway error (${playRes.status}).`,
        });
        return;
      }
      setMessage({ kind: "ok", text: "Sent to speakers." });
      if (confirmLabel) setArmed(false);
    } catch {
      setMessage({ kind: "err", text: "Unexpected error." });
    } finally {
      setBusy(false);
    }
  }

  if (confirmLabel && !armed) {
    return (
      <div className="stack">
        <button
          type="button"
          className="btn btn-danger btn-block"
          onClick={() => {
            setArmed(true);
            setMessage(null);
          }}
        >
          {confirmLabel}
        </button>
        {message ? (
          <div className={message.kind === "ok" ? "success-banner" : "error-banner"}>
            {message.text}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="stack">
      {confirmLabel ? (
        <div className="confirm-box stack">
          <p style={{ margin: 0 }}>
            This will play the evacuation message on all configured AI speakers.
            Confirm you intend to do this.
          </p>
          <button
            type="button"
            className="btn btn-danger btn-block"
            disabled={busy}
            onClick={() => void play()}
          >
            {busy ? "Sending…" : label}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            disabled={busy}
            onClick={() => setArmed(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`btn btn-block ${variant === "danger" ? "btn-danger" : "btn-primary"}`}
          disabled={busy}
          onClick={() => void play()}
        >
          {busy ? "Sending…" : label}
        </button>
      )}
      {message ? (
        <div className={message.kind === "ok" ? "success-banner" : "error-banner"}>
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
