"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Start a topic (topics wave, 2026-10-26): name the target; the server
 * creates the topic and its mapping conversation, which opens with the
 * target as the learner's first message.
 */
export function NewTopic() {
	const router = useRouter();
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const target = title.trim();
		if (!target || busy) return;
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/topics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: target }) });
			const body = await response.json() as { chatId?: string; paper?: boolean; topic?: { id: string }; error?: string };
			if (!response.ok || !body.chatId) { setError(body.error ?? "The topic could not be created."); setBusy(false); return; }
			// A paper topic traces citations first: its page shows the progress.
			if (body.paper && body.topic) router.push(`/topic/${body.topic.id}`);
			else router.push(`/chat/${body.chatId}?prompt=${encodeURIComponent(`I want to learn ${target}.`)}`);
		} catch {
			setError("The LearnHarness server could not be reached."); setBusy(false);
		}
	}
	return (
		<div className="flex h-dvh flex-col">
			<TopBar />
			<main className="flex flex-1 items-center justify-center px-4">
				<form onSubmit={submit} className="flex w-full max-w-lg flex-col gap-3" data-testid="new-topic-form">
					<h1 className="font-title text-xl tracking-tight sm:text-3xl">New topic</h1>
					<p className="text-sm text-muted-foreground">Name something you want to understand. A mapping conversation will pin down your goal, lay out every concept it rests on and probe each one — down to what you already hold — so nothing underneath gets skipped. You can stop any time and continue later.</p>
					<p className="text-sm text-muted-foreground">Or paste an <span className="text-foreground">arXiv link or id</span> to learn a paper: its citations are traced first to find where its core ideas come from, and the map is built from that.</p>
					<Input autoFocus placeholder="e.g. Transformers, real analysis — or arxiv.org/abs/1706.03762" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} data-testid="new-topic-input" />
					{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
					<Button type="submit" disabled={busy || !title.trim()} className="self-start">Start mapping</Button>
				</form>
			</main>
		</div>
	);
}
