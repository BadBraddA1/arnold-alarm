import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import {
  ensureSchema,
  insertPin,
  listAllPins,
  setPinActive,
} from "@/lib/db";
import { getSession } from "@/lib/session";
import { normalizeScopes } from "@/lib/types";

export async function GET() {
  const session = await getSession();
  if (!session?.scopes.includes("admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await ensureSchema();
  const pins = await listAllPins();
  return NextResponse.json({ pins });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.scopes.includes("admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as {
    label?: string;
    pin?: string;
    scopes?: string[];
  };
  const pin = (body.pin ?? "").replace(/\D/g, "");
  const label = (body.label ?? "").trim();
  if (!label || !/^\d{6}$/.test(pin)) {
    return NextResponse.json(
      { error: "label and 6-digit pin required" },
      { status: 400 },
    );
  }
  const scopes = normalizeScopes(body.scopes ?? ["bells"]);
  if (scopes.length === 0) {
    return NextResponse.json({ error: "at least one scope required" }, { status: 400 });
  }

  await ensureSchema();
  const pinHash = await bcrypt.hash(pin, 12);
  const id = randomUUID();
  await insertPin({ id, label, pinHash, scopes });
  return NextResponse.json({ ok: true, id, label, scopes });
}

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session?.scopes.includes("admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await req.json()) as { id?: string; active?: boolean };
  if (!body.id || typeof body.active !== "boolean") {
    return NextResponse.json({ error: "id and active required" }, { status: 400 });
  }
  await setPinActive(body.id, body.active);
  return NextResponse.json({ ok: true });
}
