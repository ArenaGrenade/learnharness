import { NextResponse, type NextRequest } from "next/server";
import { readAccess, sameOriginRequest, sessionValid, SESSION_COOKIE } from "./src/server/access.ts";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);
const NO_STORE = { "Cache-Control": "no-store" };

/** THE GATE (web host, 2026-10-25): every page and every API method —
 * SSE, spending and settings routes included — needs a valid session.
 * Only the login page and its POST are open, and state-changing requests
 * must come from this app's own pages (CSRF). Internal jobs call server
 * functions directly, never HTTP, so nothing bypasses this. */
export function proxy(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	if (!sameOriginRequest(request.method, request.headers)) {
		return NextResponse.json({ error: "Cross-site request refused." }, { status: 403, headers: NO_STORE });
	}
	if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
	if (sessionValid(readAccess(), request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
	if (pathname === "/api" || pathname.startsWith("/api/")) {
		return NextResponse.json({ error: "Sign in to LearnHarness first." }, { status: 401, headers: NO_STORE });
	}
	const login = new URL("/login", request.url);
	if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
	return NextResponse.redirect(login);
}

export const config = {
	// Everything except build assets and the bundled fonts the login page
	// itself needs; other public/ media (worklets, logos) stays behind the gate.
	// The install files are public by necessity: browsers fetch the
	// manifest, icons and service worker without credentials.
	matcher: ["/((?!_next/static|_next/image|favicon\\.ico|fonts/|manifest\\.webmanifest$|sw\\.js$|icon-192\\.png$|icon-512\\.png$|apple-touch-icon\\.png$|favicon-32\\.png$).*)"],
};
