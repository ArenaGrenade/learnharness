"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTopics } from "@/components/topics-section";
import { startNextItem } from "@/components/topic-view";
import { whatNext, type NextItem } from "@/src/core";

/** Order across topics: the same kind ranking as one topic's list. */
const KIND_ORDER: Record<NextItem["kind"], number> = { repair: 0, checkup: 1, confirm: 2, learn: 3, map: 4 };

/**
 * Home's What next card (topics wave, 2026-10-26): the top three items
 * across every topic. Renders nothing until a topic exists.
 */
export function WhatNextCard() {
	const router = useRouter();
	const topics = useTopics();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const items = useMemo(() => (topics ?? [])
		.flatMap((topic) => whatNext(topic).map((item, rank) => ({ item, topic, rank })))
		.sort((a, b) => KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.rank - b.rank)
		.slice(0, 3), [topics]);
	if (!items.length) return null;
	return (
		<div className="pointer-events-auto w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-card/85 p-3 shadow-lg backdrop-blur" data-testid="what-next-card">
			<h2 className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">What next</h2>
			<ol className="space-y-0.5">
				{items.map(({ item, topic }) => (
					<li key={`${topic.id}:${item.kind}:${item.componentId ?? ""}`}>
						<button
							type="button"
							disabled={busy}
							onClick={async () => {
								setBusy(true); setError(null);
								const failure = await startNextItem(item, topic, (href) => router.push(href));
								if (failure) { setError(failure); setBusy(false); }
							}}
							className="w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-accent disabled:opacity-50"
						>
							<span className="block truncate text-sm">{item.label}</span>
							<span className="block truncate text-xs text-muted-foreground">{topic.title}</span>
						</button>
					</li>
				))}
			</ol>
			{error && <p role="alert" className="mt-1 text-xs text-red-400">{error}</p>}
		</div>
	);
}
