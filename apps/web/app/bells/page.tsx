import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { BuildingClock } from "@/components/building-clock";
import { PlayButton } from "@/components/play-button";
import { ScheduleBellButton } from "@/components/schedule-bell-button";
import { getSession } from "@/lib/session";
import { hasScope, parseActionList } from "@/lib/types";

export default async function BellsPage() {
  const session = await getSession();
  if (!session || !hasScope(session.scopes, "bells")) redirect("/home");

  const actions = parseActionList(process.env.NEXT_PUBLIC_BELL_ACTIONS);
  const defaultSchedule =
    actions.find((a) => a.id.includes("period_end") || a.id.includes("end")) ??
    actions[0];

  return (
    <main className="app-shell">
      <AppHeader label={session.label} />
      <Link className="back-link" href="/home">
        ← Home
      </Link>
      <div className="stack">
        <BuildingClock />

        <div>
          <h1 className="page-title">Class bells</h1>
          <p className="muted" style={{ margin: 0 }}>
            Must be on church Wi‑Fi. Schedule survives closing this page — the Pi holds the timer.
          </p>
        </div>

        {defaultSchedule ? (
          <div className="card stack">
            <p style={{ margin: 0, fontWeight: 600 }}>After service</p>
            <p className="muted" style={{ margin: 0, fontSize: "0.9rem" }}>
              Service just ended? Queue the bell for 15 minutes from now.
            </p>
            <ScheduleBellButton
              actionId={defaultSchedule.id}
              actionLabel={defaultSchedule.label}
              delayMinutes={15}
            />
          </div>
        ) : null}

        {actions.length === 0 ? (
          <div className="error-banner">
            No bell actions configured. Set NEXT_PUBLIC_BELL_ACTIONS.
          </div>
        ) : (
          <>
            <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
              Play now
            </p>
            {actions.map((a) => (
              <PlayButton key={a.id} actionId={a.id} label={a.label} />
            ))}
          </>
        )}
      </div>
    </main>
  );
}
