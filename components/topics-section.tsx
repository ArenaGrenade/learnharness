"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { topicProgress, whatNext, type TopicRecord } from "@/src/core";
import { cn } from "@/lib/utils";

/** The topics list (topics wave, 2026-10-26): every topic with its held
 *  progress, linking to its page. Refetches on topics-changed. */
export function useTopics(): TopicRecord[] | null {
	const [topics, setTopics] = useState<TopicRecord[] | null>(null);
	const refresh = useCallback(async () => {
		const response = await fetch("/api/topics", { cache: "no-store" }).catch(() => null);
		if (response?.ok) setTopics(((await response.json()) as { topics: TopicRecord[] }).topics);
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);
	useServerEvent("topics-changed", () => void refresh());
	useServerResync(() => void refresh());
	return topics;
}

export function TopicsSection() {
	const topics = useTopics();
	const pathname = usePathname();
	if (!topics?.length) return null;
	return (
		<div className="mx-3 mb-3" data-testid="topics-section">
			<span className="mb-1 block px-2 text-xs uppercase tracking-widest text-muted-foreground/70">Topics</span>
			<ul className="max-h-40 overflow-y-auto">
				{topics.map((topic) => {
					const progress = topicProgress(topic);
					const due = whatNext(topic).filter((item) => item.kind !== "map").length;
					const href = `/topic/${topic.id}`;
					return (
						<li key={topic.id}>
							<Link href={href} className={cn("flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent", pathname === href && "bg-accent")} data-testid={`topic-row-${topic.id}`}>
								<span className="min-w-0 flex-1 truncate">{topic.title}</span>
								<span className="shrink-0 text-xs text-muted-foreground" title={`${progress.held} of ${progress.total} components held${due ? ` · ${due} to do` : ""}`}>{progress.held}/{progress.total}{due ? " ·" : ""}</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
