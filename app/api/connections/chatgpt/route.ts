/**
 * GET/POST /api/connections/chatgpt — the settings UI's ChatGPT controls
 * (web host, 2026-10-25; formerly the desktop shell's private IPC).
 *
 * Replies are client-safe status only: tokens, refresh handles and the PKCE
 * verifier never leave the connection host. Sign-in is paste-back: `login`
 * returns the authorize URL as status.signInUrl, `complete` takes the
 * 127.0.0.1 callback address the browser was sent to.
 */
import { chatGPTControl } from "@/src/server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
	return Response.json(await chatGPTControl({ op: "status" }), { headers: NO_STORE });
}

export async function POST(request: Request) {
	const command: unknown = await request.json().catch(() => null);
	return Response.json(await chatGPTControl(command), { headers: NO_STORE });
}
