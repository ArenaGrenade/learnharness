/**
 * GET /api/topics — every topic record (status/What next are computed by
 * the reader from core/topic.ts). POST {title} — a new topic and its
 * mapping conversation: {topic, chatId}; the client opens the chat with
 * the learner's target as the first message.
 */
import { createTopic, listTopics, TopicRequestError } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ topics: listTopics() });
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null) as { title?: unknown } | null;
	try {
		return Response.json(createTopic(typeof body?.title === "string" ? body.title : ""));
	} catch (err) {
		if (err instanceof TopicRequestError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
