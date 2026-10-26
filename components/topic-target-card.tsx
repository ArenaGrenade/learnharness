"use client";

import Link from "next/link";
import { MapIcon } from "lucide-react";
import type { TopicTargetDetails } from "@/src/core";

/**
 * The topic-target card (topics wave, 2026-10-26): message[0] of a teaching
 * session started from a topic map — which topic and component it serves,
 * linked back to the topic page. Scaffolding, not a turn: one muted line.
 * The model reads the full context through the marker's own text.
 */
export function TopicTargetCard({ data }: { data: TopicTargetDetails }) {
	if (!data?.topicId) return null;
	return (
		<div data-testid="topic-target-card" className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
			<MapIcon className="size-3 shrink-0" />
			<span>{data.purpose === "repair" ? "Repairing" : "Learning"} <span className="text-foreground">{data.componentName}</span> from</span>
			<Link href={`/topic/${data.topicId}`} className="truncate underline underline-offset-2 hover:text-foreground">{data.topicTitle}</Link>
		</div>
	);
}
