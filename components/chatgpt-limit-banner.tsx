"use client";

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import type { ChatGPTStatus } from "@/src/core";
import { connectionBridges } from "@/components/connection-bridges";
import { USAGE_PAGE } from "@/components/chatgpt-usage-meter";

/**
 * The ChatGPT limit banner (web host, 2026-10-26 — owner decision): while
 * the plan's usage limit holds background work, one quiet pill at the top
 * says until when and links to the usage page. Dismissable per limit;
 * it disappears on its own when the hold lifts.
 */
export function limitLine(limitedUntil: string, now = Date.now()): string | null {
	const until = Date.parse(limitedUntil);
	if (!(until > now)) return null;
	const sameDay = new Date(until).toDateString() === new Date(now).toDateString();
	const when = new Date(until).toLocaleString([], sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
	return `ChatGPT plan limit reached — background work paused until ${when}`;
}

export function ChatGPTLimitBanner() {
	const [status, setStatus] = useState<ChatGPTStatus | null>(null);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [, tick] = useState(0);
	useEffect(() => {
		let alive = true;
		const read = async () => {
			try {
				const value = await connectionBridges.chatgpt.status();
				if (alive && value && typeof value === "object" && "accounts" in value) setStatus(value);
			} catch { /* keep the last reading */ }
		};
		void read();
		const off = connectionBridges.chatgpt.onChange(() => void read());
		const timer = setInterval(() => tick((n) => n + 1), 60_000);
		return () => { alive = false; off(); clearInterval(timer); };
	}, []);
	const limitedUntil = status?.limitedUntil;
	const line = limitedUntil ? limitLine(limitedUntil) : null;
	if (!line || dismissed === limitedUntil) return null;
	return (
		<div role="status" data-testid="chatgpt-limit-banner" className="fixed left-1/2 top-2 z-40 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-amber-400/50 bg-card/95 px-3 py-1 text-xs text-amber-200 shadow-lg backdrop-blur">
			<span className="truncate">{line}</span>
			<a href={USAGE_PAGE} target="_blank" rel="noreferrer" className="shrink-0 underline underline-offset-2 hover:text-foreground">usage ↗</a>
			<button type="button" aria-label="Dismiss" onClick={() => setDismissed(limitedUntil!)} className="shrink-0 text-muted-foreground hover:text-foreground"><XIcon className="size-3" /></button>
		</div>
	);
}
