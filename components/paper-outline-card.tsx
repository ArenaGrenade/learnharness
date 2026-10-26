"use client";

import { useState } from "react";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import type { PaperOutlineDetails } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The paper-outline card (learn-from-a-paper, 2026-10-26): message[0] of a
 * paper topic's mapping conversation — the traced concept outline, collapsed
 * by default; expand to see the concepts and the papers they come from.
 */
export function PaperOutlineCard({ data }: { data: PaperOutlineDetails }) {
	const [open, setOpen] = useState(false);
	const outline = data?.outline;
	if (!outline) return null;
	return (
		<div data-testid="paper-outline-card" className="my-1">
			<button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
				<ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
				<FileTextIcon className="size-3" />
				Traced outline · {outline.concepts.length} concepts from {outline.papers.length} papers
			</button>
			{open && (
				<div className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs" data-testid="paper-outline-body">
					<p className="text-foreground">{outline.title}</p>
					<p className="text-muted-foreground">{outline.summary}</p>
					<ul className="space-y-1">
						{outline.concepts.map((c) => (
							<li key={c.key}>
								<span className="text-foreground">{c.name}</span> <span className="text-muted-foreground">— {c.description}</span>
								{c.sources.length > 0 && <span className="block pl-3 text-muted-foreground/80">{c.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="mr-2 underline underline-offset-2">{s.title}</a>)}</span>}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
