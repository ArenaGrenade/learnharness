"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, Trash2Icon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { TopicMap, STATUS_LABEL } from "@/components/topic-map";
import { topicProgress, topicStates, whatNext, type ComponentLinks, type NextItem, type TopicRecord } from "@/src/core";

/**
 * THE TOPIC PAGE (topics wave, 2026-10-26): one topic's map, What next,
 * and the selected component's standing. Statuses and What next are
 * computed here from the record (core/topic.ts) — the server serves the
 * record only; topics-changed on the events channel triggers a refetch.
 */

/** Start whatever a What next item (or a component action) asks for, then
 *  open its conversation with the learner's opening line. */
export async function startNextItem(item: Pick<NextItem, "kind" | "componentId">, topic: TopicRecord, navigate: (href: string) => void): Promise<string | null> {
	const open = (chatId: string, prompt?: string) => navigate(`/chat/${chatId}${prompt ? `?prompt=${encodeURIComponent(prompt)}` : ""}`);
	const name = topic.components.find((c) => c.id === item.componentId)?.name ?? "";
	try {
		// The opening line only sends into an untouched conversation; a paper
		// topic's first mapping turn names the paper.
		if (item.kind === "map") { open(topic.mapChatId, topic.components.length ? "Let's continue the map." : `I want to learn ${topic.source?.outline?.title ?? topic.title}.`); return null; }
		if (item.kind === "checkup" || item.kind === "confirm") {
			const response = await fetch(`/api/topics/${topic.id}/checkup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ componentId: item.componentId }) });
			const body = await response.json() as { chatId?: string; error?: string };
			if (!response.ok || !body.chatId) return body.error ?? "The check-up could not be started.";
			open(body.chatId, `Check me on ${name}.`);
			return null;
		}
		const response = await fetch(`/api/topics/${topic.id}/learn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ componentId: item.componentId, purpose: item.kind === "repair" ? "repair" : "learn" }) });
		const body = await response.json() as { chatId?: string; prompt?: string; error?: string };
		if (!response.ok || !body.chatId) return body.error ?? "The session could not be started.";
		open(body.chatId, body.prompt);
		return null;
	} catch {
		return "The LearnHarness server could not be reached.";
	}
}

export function TopicView({ initial, initialLinks = {} }: { initial: TopicRecord; initialLinks?: Record<string, ComponentLinks> }) {
	const router = useRouter();
	const [topic, setTopic] = useState(initial);
	const [links, setLinks] = useState(initialLinks);
	const [selected, setSelected] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const refresh = useCallback(async () => {
		const response = await fetch(`/api/topics/${initial.id}`, { cache: "no-store" }).catch(() => null);
		if (!response?.ok) return;
		const body = (await response.json()) as { topic: TopicRecord; links?: Record<string, ComponentLinks> };
		setTopic(body.topic);
		setLinks(body.links ?? {});
	}, [initial.id]);
	useServerEvent("topics-changed", (payload) => { if (payload.topicId === initial.id) void refresh(); });
	useServerResync(() => void refresh());

	const states = useMemo(() => topicStates(topic), [topic]);
	const next = useMemo(() => whatNext(topic), [topic]);
	const progress = useMemo(() => topicProgress(topic), [topic]);
	const component = topic.components.find((c) => c.id === selected) ?? null;
	const run = async (item: Pick<NextItem, "kind" | "componentId">) => {
		if (busy) return;
		setBusy(true); setError(null);
		const failure = await startNextItem(item, topic, (href) => router.push(href));
		if (failure) { setError(failure); setBusy(false); }
	};
	const remove = async () => {
		setBusy(true);
		const response = await fetch(`/api/topics/${topic.id}`, { method: "DELETE" }).catch(() => null);
		if (response?.ok) router.push("/");
		else { setError("The topic could not be deleted."); setBusy(false); }
	};

	return (
		<div className="flex h-dvh min-w-0 flex-col" data-testid="topic-view">
			<TopBar>
				<h1 className="min-w-0 flex-1 truncate font-title text-xl tracking-tight sm:text-3xl">{topic.title}</h1>
				<span className="shrink-0 text-xs text-muted-foreground" data-testid="topic-progress">{progress.held}/{progress.total} held</span>
			</TopBar>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
				<main className="min-w-0 flex-1 p-4 md:overflow-y-auto">
					{topic.source && <PaperPanel topic={topic} busy={busy} onStart={() => void run({ kind: "map" })} />}
					{topic.goal && <p className="mb-4 text-sm text-muted-foreground">Goal: <span className="text-foreground">{topic.goal}</span></p>}
					{topic.components.length ? (
						// Scrolls sideways inside its own box on narrow screens: the
						// map keeps a readable scale instead of shrinking to fit.
						<div className="overflow-x-auto">
							<TopicMap components={topic.components} statusOf={(id) => states[id]?.status ?? "unprobed"} selected={selected} onSelect={setSelected} />
						</div>
					) : !topic.source ? (
						<div className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
							<p>No map yet. The mapping conversation pins down your goal, lays out the concepts it rests on and probes each one.</p>
							<Button variant="outline" size="sm" onClick={() => void run({ kind: "map" })} disabled={busy}>Start mapping</Button>
						</div>
					) : null}
					{topic.components.length > 0 && (
						<p className="mt-4 text-xs text-muted-foreground" data-testid="topic-legend">
							Solid = held · dashed = not held yet · dotted = not probed · <span className="text-amber-300">amber</span> = shaky or check-up due · <span className="text-red-300">red</span> = misconception
						</p>
					)}
				</main>
				<aside className="w-full shrink-0 border-t border-border p-4 md:w-80 md:overflow-y-auto md:border-l md:border-t-0">
					{component && (
						<section className="mb-6 space-y-2 text-sm" data-testid="topic-component-detail">
							<h2 className="font-semibold">{component.name}</h2>
							<p className="text-xs text-muted-foreground">{component.description}</p>
							<p className="text-xs">Status: <span className="text-foreground">{STATUS_LABEL[states[component.id]!.status]}</span>{states[component.id]!.dueAt && states[component.id]!.status === "held" ? ` · check-up ${states[component.id]!.dueAt!.slice(0, 10)}` : ""}</p>
							{topic.evidence.filter((e) => e.componentId === component.id).slice(-4).reverse().map((e, i) => (
								<p key={i} className="text-xs text-muted-foreground"><span className="text-foreground/80">{e.at.slice(0, 10)} {e.kind}{e.verdict ? ` · ${e.verdict}` : ""}:</span> {e.note} <Link href={`/chat/${e.chatId}`} className="underline underline-offset-2">open</Link></p>
							))}
							{component.sources?.length ? (
								<div className="text-xs" data-testid="topic-component-sources">
									<p className="text-muted-foreground/70">Comes from</p>
									{component.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="block truncate underline-offset-2 hover:underline">{s.title}</a>)}
								</div>
							) : null}
							{links[component.id] && <ComponentLinksList links={links[component.id]!} />}
							<div className="flex flex-wrap gap-2 pt-1">
								<Button variant="outline" size="xs" disabled={busy} onClick={() => void run({ kind: states[component.id]!.status === "misconception" ? "repair" : "learn", componentId: component.id })}>{states[component.id]!.status === "misconception" ? "Repair" : "Learn"}</Button>
								<Button variant="ghost" size="xs" disabled={busy || states[component.id]!.status === "unprobed"} onClick={() => void run({ kind: "checkup", componentId: component.id })}>Check-up</Button>
							</div>
						</section>
					)}
					<section data-testid="topic-what-next">
						<h2 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground/70">What next</h2>
						{next.length === 0 ? <p className="text-xs text-muted-foreground">Nothing pending — everything mapped is held and no check-up is due.</p> : (
							<ol className="space-y-1">
								{next.map((item, i) => (
									<li key={`${item.kind}:${item.componentId ?? ""}`}>
										<button type="button" disabled={busy} onClick={() => void run(item)} className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-50" data-testid={`next-${item.kind}`}>
											<span className="mt-0.5 w-4 shrink-0 text-xs text-muted-foreground">{i + 1}.</span>
											<span className="min-w-0 flex-1">
												<span className="block text-sm text-foreground">{item.label}</span>
												<span className="line-clamp-2 block text-xs text-muted-foreground">{item.reason}</span>
											</span>
											<ArrowRightIcon className="mt-1 size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
										</button>
									</li>
								))}
							</ol>
						)}
						{topic.components.length > 0 && !next.some((n) => n.kind === "map") && (
							<button type="button" className="mt-3 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => void run({ kind: "map" })}>Open the mapping conversation</button>
						)}
					</section>
					{error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
					<div className="mt-8 border-t border-border pt-3">
						{confirmDelete ? (
							<div className="space-y-2 text-xs">
								<p className="text-red-400">Delete this topic, its map and its mapping/check-up conversations? Teaching sessions started from it stay.</p>
								<div className="flex gap-2">
									<Button variant="ghost" size="xs" onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</Button>
									<Button variant="destructive" size="xs" onClick={() => void remove()} disabled={busy} data-testid="topic-confirm-delete">Delete topic</Button>
								</div>
							</div>
						) : (
							<button type="button" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-red-400" onClick={() => setConfirmDelete(true)}><Trash2Icon className="size-3" />Delete topic…</button>
						)}
					</div>
				</aside>
			</div>
		</div>
	);
}

/** A component's derived links: the sessions taught for it and the graph
 *  propositions they produced (statement on expand). */
function ComponentLinksList({ links }: { links: ComponentLinks }) {
	return (
		<div className="space-y-2 pt-1 text-xs" data-testid="topic-component-links">
			{links.sessions.length > 0 && (
				<div>
					<p className="text-muted-foreground/70">Sessions</p>
					{links.sessions.map((s) => (
						<Link key={s.chatId} href={`/chat/${s.chatId}`} className="block truncate underline-offset-2 hover:underline">{s.purpose === "repair" ? "Repair · " : ""}{s.title}</Link>
					))}
				</div>
			)}
			{links.propositions.length > 0 && (
				<div>
					<p className="text-muted-foreground/70">In your knowledge graph ({links.propositions.length})</p>
					{links.propositions.map((p) => (
						<details key={p.id} className="group">
							<summary className="cursor-pointer list-none truncate text-foreground/90 hover:text-foreground">{p.name}</summary>
							<p className="pb-1 pl-2 text-muted-foreground">{p.statement}</p>
						</details>
					))}
				</div>
			)}
		</div>
	);
}

/** A paper topic's trace: progress while tracing, the error with a retry,
 *  and once ready the outline summary with the way into mapping. */
function PaperPanel({ topic, busy, onStart }: { topic: TopicRecord; busy: boolean; onStart: () => void }) {
	const source = topic.source!;
	const [retrying, setRetrying] = useState(false);
	const retry = async () => {
		setRetrying(true);
		await fetch(`/api/topics/${topic.id}/trace`, { method: "POST" }).catch(() => null);
		setRetrying(false);
	};
	return (
		<section className="mb-5 space-y-2 rounded-lg border border-border p-3 text-sm" data-testid="topic-paper">
			<p className="text-xs text-muted-foreground">Paper · <a href={source.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{source.arxivId}</a></p>
			{source.status === "tracing" && <p className="text-muted-foreground" data-testid="topic-paper-tracing">Tracing citations to the core ideas… <span className="font-mono text-xs">{source.progress}</span></p>}
			{source.status === "error" && (
				<div className="space-y-2">
					<p className="text-red-400">{source.error}</p>
					<Button variant="outline" size="xs" disabled={retrying} onClick={() => void retry()}>Retry the trace</Button>
				</div>
			)}
			{source.status === "ready" && source.outline && (
				<div className="space-y-2">
					<p className="text-muted-foreground">{source.outline.summary}</p>
					<p className="text-xs text-muted-foreground">{source.outline.concepts.length} core concepts traced through {source.outline.papers.length} papers.</p>
					{!topic.components.length && <Button variant="outline" size="sm" disabled={busy} onClick={onStart}>Start mapping</Button>}
				</div>
			)}
		</section>
	);
}
