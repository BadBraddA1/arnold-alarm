"use client";

import { useCallback, useEffect, useState } from "react";

type Status = "checking" | "online" | "offline";

export function GatewayStatus() {
  const [status, setStatus] = useState<Status>("checking");
  const gatewayUrl =
    process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://alarm-gw.local:8787";

  const check = useCallback(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${gatewayUrl}/health`, {
        signal: ctrl.signal,
        cache: "no-store",
      });
      setStatus(res.ok ? "online" : "offline");
    } catch {
      setStatus("offline");
    } finally {
      clearTimeout(timer);
    }
  }, [gatewayUrl]);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), 15000);
    return () => clearInterval(id);
  }, [check]);

  const label =
    status === "online"
      ? "Gateway online (church Wi‑Fi)"
      : status === "checking"
        ? "Checking gateway…"
        : "Gateway unreachable — join church Wi‑Fi to play";

  return (
    <div className="status-row" title={gatewayUrl}>
      <span
        className={`dot ${status === "online" ? "ok" : status === "checking" ? "warn" : "bad"}`}
      />
      <span>{label}</span>
    </div>
  );
}
