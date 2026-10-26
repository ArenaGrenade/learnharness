/** GET /api/topics/[id] — one topic record plus each component's derived
 *  links (targeted sessions, propositions born in them). DELETE — the topic and its own
 *  conversations (mapping + check-ups); teaching sessions stay. */
import { deleteTopic, getTopic, topicLinks } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const topic = getTopic((await params).id);
	return topic ? Response.json({ topic, links: topicLinks(topic.id) }) : Response.json({ error: "Topic not found." }, { status: 404 });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	return deleteTopic((await params).id) ? Response.json({ ok: true }) : Response.json({ error: "Topic not found." }, { status: 404 });
}
