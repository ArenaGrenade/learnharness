/** POST {subscription, label} — this device receives notifications.
 *  DELETE {endpoint} — it stops. */
import { PushRequestError, subscribePush, unsubscribePush } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = await request.json().catch(() => null) as { subscription?: unknown; label?: unknown } | null;
	try { subscribePush(body?.subscription, typeof body?.label === "string" ? body.label : "Device"); return Response.json({ ok: true }); }
	catch (err) { if (err instanceof PushRequestError) return Response.json({ error: err.message }, { status: 400 }); throw err; }
}

export async function DELETE(request: Request) {
	const body = await request.json().catch(() => null) as { endpoint?: unknown } | null;
	if (typeof body?.endpoint === "string") unsubscribePush(body.endpoint);
	return Response.json({ ok: true });
}
