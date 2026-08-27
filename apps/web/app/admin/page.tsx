"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";

type Pin = {
  id: string;
  label: string;
  scopes: string[];
  active: boolean;
  created_at: string;
};

export default function AdminPage() {
  const [pins, setPins] = useState<Pin[]>([]);
  const [label, setLabel] = useState("");
  const [pin, setPin] = useState("");
  const [scopes, setScopes] = useState({ bells: true, evacuate: false, admin: false });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/admin/pins");
    if (!res.ok) return;
    const data = (await res.json()) as { pins: Pin[] };
    setPins(data.pins);
  }

  useEffect(() => {
    void load();
  }, []);

  async function createPin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const scopeList = [
      scopes.bells ? "bells" : null,
      scopes.evacuate ? "evacuate" : null,
      scopes.admin ? "admin" : null,
    ].filter(Boolean);
    try {
      const res = await fetch("/api/admin/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, pin, scopes: scopeList }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed to create PIN");
        return;
      }
      setOk("PIN created.");
      setLabel("");
      setPin("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, active: boolean) {
    await fetch("/api/admin/pins", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, active }),
    });
    await load();
  }

  return (
    <main className="app-shell">
      <AppHeader />
      <Link className="back-link" href="/home">
        ← Home
      </Link>
      <div className="stack">
        <div>
          <h1 className="page-title">PIN admin</h1>
          <p className="muted" style={{ margin: 0 }}>
            Hashed PINs only. Share new codes out-of-band.
          </p>
        </div>

        <form className="card stack" onSubmit={(e) => void createPin(e)}>
          <div className="field">
            <label htmlFor="label">Label</label>
            <input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Office desk"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="pin">6-digit PIN</label>
            <input
              id="pin"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
            />
          </div>
          <div className="checks">
            <label>
              <input
                type="checkbox"
                checked={scopes.bells}
                onChange={(e) => setScopes((s) => ({ ...s, bells: e.target.checked }))}
              />
              Class bells
            </label>
            <label>
              <input
                type="checkbox"
                checked={scopes.evacuate}
                onChange={(e) => setScopes((s) => ({ ...s, evacuate: e.target.checked }))}
              />
              Evacuation
            </label>
            <label>
              <input
                type="checkbox"
                checked={scopes.admin}
                onChange={(e) => setScopes((s) => ({ ...s, admin: e.target.checked }))}
              />
              Admin
            </label>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add PIN"}
          </button>
          {error ? <div className="error-banner">{error}</div> : null}
          {ok ? <div className="success-banner">{ok}</div> : null}
        </form>

        <div className="card" style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Scopes</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pins.map((p) => (
                <tr key={p.id}>
                  <td>{p.label}</td>
                  <td>{p.scopes.join(", ")}</td>
                  <td>{p.active ? "Active" : "Revoked"}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ minHeight: "2.25rem", padding: "0.4rem 0.7rem" }}
                      onClick={() => void toggle(p.id, !p.active)}
                    >
                      {p.active ? "Revoke" : "Restore"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
