"use client";

import { useEffect, useState } from "react";
import type { ChatGPTPlanUsage, ChatGPTUsageWindow } from "@/src/core";
import { CONNECTIONS_CHANGED_EVENT } from "@/components/connection-bridges";
import { cn } from "@/lib/utils";

/**
 * THE CHATGPT PLAN METER (web host, 2026-10-26 — owner decision): the live
 * 5-hour and weekly usage of the active ChatGPT account, beside the model
 * picker while a ChatGPT model is selected and on the Settings row. The
 * source is undocumented (the server reads it with the app's own sign-in,
 * cached two minutes), so when ChatGPT refuses, the meter falls back to a
 * link to the official usage page. The whole meter links there too.
 */
export const USAGE_PAGE = "https://chatgpt.com/settings/usage";
const REFRESH_MS = 120_000;

export function usageTone(percent: number): string {
	return percent >= 95 ? "text-red-400" : percent >= 80 ? "text-amber-300" : "text-muted-foreground";
}

export function usageTitle(windows: readonly ChatGPTUsageWindow[], planType?: string): string {
	const lines = windows.map((w) => `${w.label}: ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}`);
	return [`ChatGPT${planType ? ` ${planType}` : ""} plan usage`, ...lines, "Open ChatGPT usage settings"].join("\n");
}

export function ChatGPTUsageMeter({ className }: { className?: string }) {
	const [usage, setUsage] = useState<ChatGPTPlanUsage | null>(null);
	useEffect(() => {
		let alive = true;
		const read = async () => {
			if (document.visibilityState === "hidden") return;
			try {
				const response = await fetch("/api/connections/chatgpt/usage", { cache: "no-store" });
				if (!alive || !response.ok) return;
				setUsage(((await response.json()) as { usage: ChatGPTPlanUsage }).usage);
			} catch { /* server unreachable: keep the last reading */ }
		};
		void read();
		const timer = setInterval(() => void read(), REFRESH_MS);
		const onChange = () => void read();
		window.addEventListener(CONNECTIONS_CHANGED_EVENT, onChange);
		document.addEventListener("visibilitychange", onChange);
		return () => { alive = false; clearInterval(timer); window.removeEventListener(CONNECTIONS_CHANGED_EVENT, onChange); document.removeEventListener("visibilitychange", onChange); };
	}, []);
	if (!usage) return null;
	if (!usage.available) {
		return <a href={USAGE_PAGE} target="_blank" rel="noreferrer" title={usage.reason} data-testid="chatgpt-usage-link" className={cn("shrink-0 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline", className)}>plan usage ↗</a>;
	}
	return (
		<a href={USAGE_PAGE} target="_blank" rel="noreferrer" title={usageTitle(usage.windows, usage.planType)} data-testid="chatgpt-usage-meter" className={cn("flex shrink-0 items-center gap-1 font-mono text-[11px] hover:underline", className)}>
			{usage.windows.map((w, i) => (
				<span key={w.label} className={usageTone(w.usedPercent)}>{i > 0 && <span className="text-muted-foreground/60">· </span>}{w.label} {Math.round(w.usedPercent)}%</span>
			))}
		</a>
	);
}
