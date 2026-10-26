/** POST /api/topics/[id]/learn {componentId, purpose: "learn"|"repair"} —
 *  start a teaching session targeted at one component: {chatId, prompt};
 *  the client opens the chat with `prompt` as the learner's first message. */
import { startLearning, TopicRequestError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const body = await request.json().catch(() => null) as { componentId?: unknown; purpose?: unknown } | null;
	try {
		const purpose = body?.purpose === "repair" ? "repair" : "learn";
		return Response.json(startLearning((await params).id, typeof body?.componentId === "string" ? body.componentId : "", purpose));
	} catch (err) {
		if (err instanceof TopicRequestError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
