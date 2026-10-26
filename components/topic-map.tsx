"use client";

import { useMemo } from "react";
import { ARROW_HEAD, blockLayout, edgePathD, LINE_H, NODE_H, NODE_W_MIN, STROKE_W, wrapTitle } from "@/components/plan-block";
import type { ComponentStatus, TopicComponent } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * THE TOPIC MAP (topics wave, 2026-10-26): a topic's components as a DAG —
 * foundations on top, the target at the bottom — placed by the plan
 * diagram's engine (dagre via blockLayout) and skinned by STATUS. The
 * minimal-color doctrine holds: held is plain white, the colors mark only
 * what asks for action (amber = shaky/due, red = misconception), dashed =
 * not yet held, dotted = not yet probed. Clicking a node selects it.
 */

export const STATUS_LABEL: Record<ComponentStatus, string> = {
	unprobed: "Not probed",
	held: "Held",
	due: "Check-up due",
	taught: "Taught",
	shaky: "Shaky",
	misconception: "Misconception",
	missing: "Missing",
};

const BOX: Record<ComponentStatus, string> = {
	held: "fill-background stroke-white",
	due: "fill-background stroke-amber-400",
	taught: "fill-background stroke-white [stroke-dasharray:4_3]",
	shaky: "fill-background stroke-amber-400 [stroke-dasharray:4_3]",
	misconception: "fill-background stroke-red-400",
	missing: "fill-background stroke-muted-foreground [stroke-dasharray:4_3]",
	unprobed: "fill-background stroke-border [stroke-dasharray:1_3]",
};
const TEXT: Record<ComponentStatus, string> = {
	held: "fill-white text-xs",
	due: "fill-amber-300 text-xs",
	taught: "fill-white text-xs",
	shaky: "fill-amber-300 text-xs",
	misconception: "fill-red-300 text-xs",
	missing: "fill-muted-foreground text-xs",
	unprobed: "fill-muted-foreground/60 text-xs",
};

export function TopicMap({
	components,
	statusOf,
	selected,
	onSelect,
}: {
	components: readonly TopicComponent[];
	statusOf: (id: string) => ComponentStatus;
	selected: string | null;
	onSelect: (id: string) => void;
}) {
	const nodes = useMemo(() => components.map((c) => ({ id: c.id, title: c.name })), [components]);
	const edges = useMemo(() => components.flatMap((c) => c.prerequisites.map((p) => ({ from: p, to: c.id }))), [components]);
	const layout = useMemo(() => blockLayout(nodes, edges), [nodes, edges]);
	const pad = 12;
	const ox = (layout.originX ?? 0) - pad, oy = (layout.originY ?? 0) - pad;
	const headH = 16 * (STROKE_W / 1.5), headW = 50.2 * (headH / 104);
	return (
		<svg
			viewBox={`${ox} ${oy} ${layout.width + 2 * pad} ${layout.height + 2 * pad}`}
			className="mx-auto block h-auto w-full"
			style={{ fontFamily: "var(--font-prose)", maxWidth: `${Math.round((layout.width + 2 * pad) * 1.4)}px`, minWidth: `${Math.round((layout.width + 2 * pad) * 0.85)}px` }}
			role="img"
			aria-label="Topic map"
			data-testid="topic-map"
		>
			<defs>
				<marker id="topic-arrow" viewBox="0 0 50.2 104" refX={27.2} refY={52} markerWidth={headW} markerHeight={headH} markerUnits="userSpaceOnUse" orient="auto">
					<path d={ARROW_HEAD} className="fill-muted-foreground" />
				</marker>
			</defs>
			{edges.map((e) => {
				const pts = layout.edgePts.get(`${e.from}->${e.to}`);
				if (!pts) return null;
				const tx = layout.x.get(e.to), ty = layout.y.get(e.to);
				const target = tx !== undefined && ty !== undefined ? { x: tx, y: ty, w: layout.nodeW.get(e.to) ?? NODE_W_MIN, h: layout.nodeH.get(e.to) ?? NODE_H } : undefined;
				return <path key={`${e.from}->${e.to}`} d={edgePathD(pts, target)} className="fill-none stroke-muted-foreground" strokeWidth={STROKE_W} markerEnd="url(#topic-arrow)" />;
			})}
			{components.map((c) => {
				const status = statusOf(c.id);
				const lines = wrapTitle(c.name);
				const h = layout.nodeH.get(c.id) ?? NODE_H, w = layout.nodeW.get(c.id) ?? NODE_W_MIN;
				const y0 = (h - lines.length * LINE_H) / 2 + 10;
				return (
					<g
						key={c.id}
						transform={`translate(${layout.x.get(c.id) ?? 0}, ${layout.y.get(c.id) ?? 0})`}
						data-testid={`topic-node-${c.id}`}
						data-status={status}
						className="cursor-pointer"
						role="button"
						tabIndex={0}
						aria-label={`${c.name}: ${STATUS_LABEL[status]}`}
						onClick={() => onSelect(c.id)}
						onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(c.id); } }}
					>
						<rect width={w} height={h} className={cn(BOX[status], selected === c.id && "stroke-[2px]")} strokeWidth={selected === c.id ? 2 : STROKE_W} />
						{lines.map((line, i) => (
							<text key={i} x={w / 2} y={y0 + i * LINE_H} textAnchor="middle" className={TEXT[status]}>{line}</text>
						))}
					</g>
				);
			})}
		</svg>
	);
}
