/** GET /api/push — the VAPID public key, the digest time and the subscribed
 *  devices. PUT {digestTime: "HH:MM"} — set the daily digest time. */
import { pushPublicKey, pushSettings, PushRequestError, setDigestTime } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ publicKey: pushPublicKey(), ...pushSettings() });
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null) as { digestTime?: unknown } | null;
	try { setDigestTime(body?.digestTime); return Response.json(pushSettings()); }
	catch (err) { if (err instanceof PushRequestError) return Response.json({ error: err.message }, { status: 400 }); throw err; }
}
