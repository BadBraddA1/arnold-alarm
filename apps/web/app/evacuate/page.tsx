import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { PlayButton } from "@/components/play-button";
import { getSession } from "@/lib/session";
import { hasScope, parseActionList } from "@/lib/types";

export default async function EvacuatePage() {
  const session = await getSession();
  if (!session || !hasScope(session.scopes, "evacuate")) redirect("/home");

  const [action] = parseActionList(process.env.NEXT_PUBLIC_EVACUATE_ACTION);
  const actionId = action?.id ?? "evacuate.main";
  const label = action?.label ?? "Play evacuation";

  return (
    <main className="app-shell">
      <AppHeader label={session.label} />
      <Link className="back-link" href="/home">
        ← Home
      </Link>
      <div className="stack">
        <div>
          <h1 className="page-title">Evacuation</h1>
          <p className="muted" style={{ margin: 0 }}>
            Requires church Wi‑Fi. Confirm before sending.
          </p>
        </div>
        <PlayButton
          actionId={actionId}
          label={label}
          variant="danger"
          confirmLabel="Arm evacuation alarm"
        />
      </div>
    </main>
  );
}
