import { notFound } from "next/navigation";
import { TopicView } from "@/components/topic-view";
import { getTopic, topicLinks } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
	const topic = getTopic((await params).id);
	if (!topic) notFound();
	return <TopicView key={topic.id} initial={topic} initialLinks={topicLinks(topic.id)} />;
}
