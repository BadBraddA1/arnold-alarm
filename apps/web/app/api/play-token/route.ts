import { NextResponse } from "next/server";
import { signPlayToken } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { hasScope, type Scope } from "@/lib/types";

function actionAllowed(actionId: string, scopes: Scope[]): boolean {
  if (scopes.includes("admin")) return true;
  if (actionId.startsWith("bells.") && hasScope(scopes, "bells")) return true;
  if (actionId.startsWith("evacuate.") && hasScope(scopes, "evacuate")) return true;
  return false;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { actionId?: string };
  const actionId = body.actionId?.trim();
  if (!actionId) {
    return NextResponse.json({ error: "actionId required" }, { status: 400 });
  }
  if (!actionAllowed(actionId, session.scopes)) {
    return NextResponse.json({ error: "Not allowed for this PIN." }, { status: 403 });
  }

  const token = await signPlayToken({
    pinId: session.pinId,
    scopes: session.scopes,
    actionId,
  });

  return NextResponse.json({
    token,
    gatewayUrl: process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://alarm-gw.local:8787",
    expiresInSec: 60,
  });
}
