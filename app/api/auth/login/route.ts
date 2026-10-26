/**
 * POST /api/auth/login — exchange the passphrase for a session cookie
 * (web host, 2026-10-25). Open route (the proxy lets it through), but
 * still same-origin only. Failed attempts back off (src/server/access.ts).
 */
import { NextResponse } from "next/server";
import { issueSession, loginThrottle, readAccess, verifyPassphrase, SESSION_COOKIE, SESSION_MAX_AGE_S } from "@/src/server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
	const record = readAccess();
	if (!record) {
		return NextResponse.json({ error: "No passphrase is set yet. On the server, run: npm run set-passphrase" }, { status: 503, headers: NO_STORE });
	}
	const throttle = loginThrottle();
	const wait = throttle.wait();
	if (wait > 0) {
		const seconds = Math.ceil(wait / 1000);
		return NextResponse.json({ error: `Too many failed attempts. Try again in ${seconds} s.` }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(seconds) } });
	}
	const body = await request.json().catch(() => null) as { passphrase?: unknown } | null;
	const passphrase = typeof body?.passphrase === "string" && body.passphrase.length <= 1024 ? body.passphrase : "";
	if (!passphrase || !await verifyPassphrase(record, passphrase)) {
		throttle.fail();
		return NextResponse.json({ error: "Wrong passphrase." }, { status: 401, headers: NO_STORE });
	}
	throttle.succeed();
	const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
	response.cookies.set({ name: SESSION_COOKIE, value: issueSession(record), httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: SESSION_MAX_AGE_S });
	return response;
}
