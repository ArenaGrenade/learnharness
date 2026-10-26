/**
 * GET/POST /api/connections/subscriptions — GitHub Copilot and Grok
 * device-code connections (web host, 2026-10-25; formerly desktop IPC).
 *
 * Status carries only public interaction data (device user codes, prompts).
 * `login` starts the flow and returns at once; its progress and outcome
 * arrive as status through `connections-changed` on /api/events.
 */
import { subscriptionControl } from "@/src/server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
	return Response.json(await subscriptionControl({ op: "status" }), { headers: NO_STORE });
}

export async function POST(request: Request) {
	const command: unknown = await request.json().catch(() => null);
	return Response.json(await subscriptionControl(command), { headers: NO_STORE });
}
