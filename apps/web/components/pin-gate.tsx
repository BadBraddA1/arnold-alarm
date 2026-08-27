"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function PinGate() {
  const router = useRouter();
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  function setDigit(index: number, value: string) {
    const d = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = d;
    setDigits(next);
    setError(null);
    if (d && index < 5) refs.current[index + 1]?.focus();
    if (next.every((x) => x.length === 1)) {
      void submit(next.join(""));
    }
  }

  function onKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!text) return;
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < text.length; i++) next[i] = text[i]!;
    setDigits(next);
    if (text.length === 6) void submit(text);
    else refs.current[text.length]?.focus();
  }

  async function submit(pin: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not sign in.");
        setDigits(["", "", "", "", "", ""]);
        refs.current[0]?.focus();
        return;
      }
      router.replace("/home");
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell" style={{ justifyContent: "center" }}>
      <div className="card stack" style={{ gap: "1.25rem" }}>
        <div>
          <p className="muted" style={{ margin: "0 0 0.35rem", textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.75rem" }}>
            Arnold Church of Christ
          </p>
          <h1 className="page-title">Alarm</h1>
          <p className="muted" style={{ margin: 0 }}>
            Enter your 6-digit PIN to continue.
          </p>
        </div>

        <div className="pin-inputs" onPaste={onPaste}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              inputMode="numeric"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              maxLength={1}
              value={d}
              disabled={busy}
              aria-label={`Digit ${i + 1}`}
              onChange={(e) => setDigit(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
            />
          ))}
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        {busy ? <p className="muted">Checking PIN…</p> : null}
      </div>
    </main>
  );
}
