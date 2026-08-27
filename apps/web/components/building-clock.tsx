"use client";

import { useEffect, useState } from "react";

/** Building clock — America/Chicago (Arnold, MO). */
const TZ = "America/Chicago";

function parts(now: Date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(now);
  return { time: dtf.format(now), date };
}

export function BuildingClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 250);
    return () => clearInterval(id);
  }, []);

  const { time, date } = parts(now);

  return (
    <div
      className="card"
      style={{
        textAlign: "center",
        padding: "1.5rem 1rem 1.25rem",
        background:
          "linear-gradient(180deg, color-mix(in oklab, #243044 55%, transparent), var(--bg-elevated))",
      }}
    >
      <p
        className="muted"
        style={{
          margin: "0 0 0.35rem",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          fontSize: "0.72rem",
        }}
      >
        Building time
      </p>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(2.75rem, 14vw, 4.25rem)",
          fontWeight: 600,
          letterSpacing: "-0.03em",
          lineHeight: 1.05,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {time}
      </div>
      <p className="muted" style={{ margin: "0.45rem 0 0", fontSize: "0.95rem" }}>
        {date} · Central
      </p>
    </div>
  );
}
