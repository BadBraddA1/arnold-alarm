import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { getSession } from "@/lib/session";
import { hasScope } from "@/lib/types";

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/");

  const canBells = hasScope(session.scopes, "bells");
  const canEvacuate = hasScope(session.scopes, "evacuate");
  const canAdmin = session.scopes.includes("admin");

  return (
    <main className="app-shell">
      <AppHeader label={session.label} />
      <div className="stack">
        <div>
          <h1 className="page-title">Choose a panel</h1>
          <p className="muted" style={{ margin: 0 }}>
            Access is limited to what your PIN allows.
          </p>
        </div>
        <div className="tile-grid">
          {canBells ? (
            <Link className="tile" href="/bells">
              <h2>Class bells</h2>
              <p>Play period and chapel tones on campus speakers.</p>
            </Link>
          ) : null}
          {canEvacuate ? (
            <Link className="tile" href="/evacuate">
              <h2>Evacuation</h2>
              <p>Trigger the building evacuation message.</p>
            </Link>
          ) : null}
          {canAdmin ? (
            <Link className="tile" href="/admin">
              <h2>PIN admin</h2>
              <p>Add or revoke staff PINs.</p>
            </Link>
          ) : null}
          {!canBells && !canEvacuate && !canAdmin ? (
            <div className="error-banner">
              This PIN has no panels assigned. Ask an admin to update scopes.
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
