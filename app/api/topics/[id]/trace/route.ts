/** POST /api/topics/[id]/trace — re-run a paper topic's citation trace
 *  (after an error). Returns at once; progress arrives as topics-changed. */
import { getTopic, tracePaper } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const topic = getTopic((await params).id);
	if (!topic?.source) return Response.json({ error: "Not a paper topic." }, { status: 404 });
	if (topic.source.status === "tracing") return Response.json({ error: "The trace is already running." }, { status: 409 });
	void tracePaper(topic.id);
	return Response.json({ ok: true });
}
