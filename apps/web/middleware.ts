import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { SESSION_COOKIE, type Scope } from "./lib/types";

async function readSession(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return {
      pinId: String(payload.pinId ?? ""),
      label: String(payload.label ?? ""),
      scopes: (payload.scopes as Scope[]) ?? [],
    };
  } catch {
    return null;
  }
}

function has(scopes: Scope[], needed: Scope) {
  return scopes.includes("admin") || scopes.includes(needed);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = await readSession(req);

  if (pathname === "/" || pathname.startsWith("/api/auth/pin")) {
    if (session && pathname === "/") {
      return NextResponse.redirect(new URL("/home", req.url));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/auth/logout") || pathname.startsWith("/api/auth/session")) {
    return NextResponse.next();
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/", req.url));
  }

  if (pathname.startsWith("/bells") && !has(session.scopes, "bells")) {
    return NextResponse.redirect(new URL("/home", req.url));
  }
  if (pathname.startsWith("/evacuate") && !has(session.scopes, "evacuate")) {
    return NextResponse.redirect(new URL("/home", req.url));
  }
  if (pathname.startsWith("/admin") && !has(session.scopes, "admin")) {
    return NextResponse.redirect(new URL("/home", req.url));
  }
  if (pathname.startsWith("/api/admin") && !has(session.scopes, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/home",
    "/bells/:path*",
    "/evacuate/:path*",
    "/admin/:path*",
    "/api/auth/:path*",
    "/api/play-token",
    "/api/admin/:path*",
  ],
};
