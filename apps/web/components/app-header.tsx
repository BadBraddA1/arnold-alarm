"use client";

import { useRouter } from "next/navigation";
import { GatewayStatus } from "./gateway-status";

export function AppHeader({
  label,
  showLogout = true,
}: {
  label?: string;
  showLogout?: boolean;
}) {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
    router.refresh();
  }

  return (
    <header className="app-header">
      <div>
        <div className="brand">
          Arnold <span>Alarm</span>
        </div>
        {label ? <div className="muted">{label}</div> : null}
        <div style={{ marginTop: "0.4rem" }}>
          <GatewayStatus />
        </div>
      </div>
      {showLogout ? (
        <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
          Sign out
        </button>
      ) : null}
    </header>
  );
}
