/** POST /api/topics/[id]/checkup {componentId} — start a short check-up
 *  conversation for one component: {chatId}. */
import { startCheckup, TopicRequestError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const body = await request.json().catch(() => null) as { componentId?: unknown } | null;
	try {
		return Response.json(startCheckup((await params).id, typeof body?.componentId === "string" ? body.componentId : ""));
	} catch (err) {
		if (err instanceof TopicRequestError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
