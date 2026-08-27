import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { signSession } from "@/lib/auth";
import {
  checkRateLimit,
  clearRateLimit,
  ensureSchema,
  listActivePins,
} from "@/lib/db";
import { normalizeScopes, SESSION_COOKIE, SESSION_MAX_AGE_SEC } from "@/lib/types";

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json()) as { pin?: string };
    const pin = (body.pin ?? "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(pin)) {
      return NextResponse.json({ error: "Enter a 6-digit PIN." }, { status: 400 });
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";

    const limit = await checkRateLimit(ip);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again in 15 minutes." },
        { status: 429 },
      );
    }

    const pins = await listActivePins();
    let matched: (typeof pins)[0] | null = null;
    for (const row of pins) {
      if (await bcrypt.compare(pin, row.pin_hash)) {
        matched = row;
        break;
      }
    }

    if (!matched) {
      return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });
    }

    await clearRateLimit(ip);
    const scopes = normalizeScopes(matched.scopes);
    const token = await signSession({
      pinId: matched.id,
      label: matched.label,
      scopes,
    });

    const res = NextResponse.json({
      ok: true,
      label: matched.label,
      scopes,
    });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SEC,
    });
    return res;
  } catch (err) {
    console.error("pin auth error", err);
    return NextResponse.json({ error: "Auth service unavailable." }, { status: 500 });
  }
}
