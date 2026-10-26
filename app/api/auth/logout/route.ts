/**
 * POST /api/auth/logout — end THIS browser's session (web host, 2026-10-26).
 * Behind the gate like every other route; other devices stay signed in
 * (changing the passphrase is the sign-out-everywhere lever).
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST() {
	const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
	response.cookies.set({ name: SESSION_COOKIE, value: "", httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0 });
	return response;
}
