/**
 * THE MAPPER'S TOOLS (topics wave, 2026-10-26): read the topic map, grow it,
 * record measured standing, conclude. Mechanics only — the method lives in
 * prompts/mapper/10-mapping-doctrine.md.
 *
 * Every write goes through the TopicStore port (the store is the only
 * writer); map edits are validated by the pure core (applyMapComponents —
 * unknown references and prerequisite cycles are refused with nothing
 * applied, the plan_init return-to-agent doctrine). Refusals return an
 * isError result the model fixes and retries.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { mapComponentsInput, mapVerdictInput, type ChatTopicLink, type ChatTopicTarget, type TopicRecord, type TopicVerdict } from "../../core/contracts.ts";
import type { TopicStore } from "../../core/ports.ts";
import { applyMapComponents, mapGaps, topicStates } from "../../core/topic.ts";
import { invalidInputResult } from "../tool-execute.ts";

export interface TopicToolContext {
	chatId: string;
	link: ChatTopicLink;
	topicStore: TopicStore;
}

const text = (value: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: value }], details: null });
const componentId = () => `c_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

/** The map as the agent reads it: every component with status, verdict
 *  note and prerequisites, in prerequisite-first order. */
export function renderTopicMap(record: TopicRecord, link: ChatTopicLink, now = Date.now()): string {
	const states = topicStates(record, now);
	const name = (id: string) => record.components.find((c) => c.id === id)?.name ?? id;
	const lines = [
		`TOPIC: ${record.title}`,
		`GOAL: ${record.goal ?? "(not concrete yet — make it concrete first, then pass it as goal in map_components)"}`,
		link.mode === "checkup"
			? `MODE: check-up of ONE component — ${name(link.componentId ?? "")} (${link.componentId}). Ask 2–4 questions that would expose decay, record exactly one map_verdict for it, close in one sentence, end your turn.`
			: `MODE: mapping${record.mappedAt ? ` (concluded ${record.mappedAt.slice(0, 10)} — continue only if he asks to extend or re-check)` : ""}`,
		"",
	];
	if (!record.components.length) lines.push("COMPONENTS: none yet.");
	else {
		lines.push(`COMPONENTS (${record.components.length}):`);
		for (const c of record.components) {
			const s = states[c.id]!;
			const prereqs = c.prerequisites.length ? ` — rests on: ${c.prerequisites.map(name).join(", ")}` : c.foundation ? " — foundation" : " — no prerequisites recorded";
			lines.push(`- [${c.id}] ${c.name}: ${s.status.toUpperCase()}${prereqs}`);
			lines.push(`    ${c.description}`);
			if (s.note) lines.push(`    evidence: ${s.note}`);
		}
	}
	if (link.mode === "map") {
		const gaps = mapGaps(record, now);
		lines.push("", gaps.length ? `OPEN (map_done refuses until these close):\n${gaps.map((g) => `- ${g}`).join("\n")}` : "OPEN: nothing — the map reaches held ground; call map_done if you have not.");
	}
	return lines.join("\n");
}

export function topicTools(ctx: TopicToolContext): Record<string, AgentTool<any>> {
	const load = () => ctx.topicStore.getTopic(ctx.link.topicId);
	const missing = (tool: string) => invalidInputResult(tool, ["this conversation's topic no longer exists"]);
	const mapping = ctx.link.mode === "map";

	const topic_map: AgentTool<any> = {
		name: "topic_map",
		label: "topic_map",
		description: "Show the topic map: the goal, every component with its status (UNPROBED, HELD, DUE, TAUGHT, SHAKY, MISCONCEPTION, MISSING), evidence notes, prerequisites, the mode you are in, and what keeps the map open. Call it at the start of every turn.",
		parameters: Type.Object({}),
		execute: async () => {
			const record = load();
			return record ? text(renderTopicMap(record, ctx.link)) : missing("topic_map");
		},
	};

	const map_verdict: AgentTool<typeof mapVerdictInput> = {
		name: "map_verdict",
		label: "map_verdict",
		description: "Record his measured standing on ONE component, once it is bracketed (or after a check-up): held, shaky, misconception or missing, with a short note of where the floor and ceiling sit. Appends evidence; never overwrites earlier evidence.",
		parameters: mapVerdictInput,
		execute: async (_id, input) => {
			const record = load();
			if (!record) return missing("map_verdict");
			if (!record.components.some((c) => c.id === input.component)) return invalidInputResult("map_verdict", [`unknown component "${input.component}" — use an id from topic_map`]);
			if (!mapping && input.component !== ctx.link.componentId) return invalidInputResult("map_verdict", [`this is a check-up of ${ctx.link.componentId}; record the verdict for that component only`]);
			const next = ctx.topicStore.appendEvidence(record.id, {
				componentId: input.component,
				kind: mapping ? "map" : "checkup",
				verdict: input.verdict as TopicVerdict,
				note: input.note.trim(),
				chatId: ctx.chatId,
				at: new Date().toISOString(),
			});
			if (!next) return missing("map_verdict");
			const state = topicStates(next)[input.component]!;
			return text(`Recorded: ${record.components.find((c) => c.id === input.component)!.name} is now ${state.status.toUpperCase()}.${mapping && (input.verdict === "missing" || input.verdict === "shaky") ? " Descend: add what it rests on (map_components with links) and probe those — unless it is a foundation." : ""}`);
		},
	};

	if (!mapping) return { topic_map, map_verdict };

	const map_components: AgentTool<typeof mapComponentsInput> = {
		name: "map_components",
		label: "map_components",
		description: "Grow the map: add components (concepts, each the size one teaching session can take) with their prerequisites, add prerequisite links between components, and set the concrete goal. New components are referenced by your keys within the call; the result lists their assigned ids. Refused with nothing applied when a reference is unknown or prerequisites would form a cycle.",
		parameters: mapComponentsInput,
		execute: async (_id, input) => {
			const record = load();
			if (!record) return missing("map_components");
			const applied = applyMapComponents(record.components, input, componentId, new Date().toISOString());
			if (!applied.ok) return invalidInputResult("map_components", applied.errors);
			ctx.topicStore.saveComponents(record.id, applied.components, input.goal);
			const added = Object.entries(applied.ids).map(([key, id]) => `${key} → ${id}`);
			return text(`Map updated.${added.length ? ` New component ids: ${added.join(", ")}.` : ""}${input.goal ? " Goal recorded." : ""} Probe the new components next.`);
		},
	};

	const map_done: AgentTool<any> = {
		name: "map_done",
		label: "map_done",
		description: "Conclude the mapping: refused while any component is unprobed or a missing/shaky branch has not been descended to held ground or a foundation — the refusal lists what remains. After it succeeds, say a short closing sentence and end your turn.",
		parameters: Type.Object({}),
		execute: async () => {
			const record = load();
			if (!record) return missing("map_done");
			const gaps = mapGaps(record);
			if (gaps.length) return invalidInputResult("map_done", gaps);
			ctx.topicStore.markMapped(record.id, new Date().toISOString());
			return text("Map concluded — it reaches held ground everywhere. Close in one or two sentences: what he holds, where the frontier is. End your turn.");
		},
	};

	const list_topics: AgentTool<any> = {
		name: "list_topics",
		label: "list_topics",
		description: "List his OTHER topics with their components and statuses — evidence measured there can be carried over here with map_verdict (say so in the note) instead of re-probing.",
		parameters: Type.Object({}),
		execute: async () => {
			const others = ctx.topicStore.listTopics().filter((t) => t.id !== ctx.link.topicId);
			if (!others.length) return text("No other topics.");
			return text(others.map((t) => {
				const states = topicStates(t);
				return `${t.title}:\n${t.components.map((c) => `- ${c.name}: ${states[c.id]!.status}${states[c.id]!.note ? ` (${states[c.id]!.note})` : ""}`).join("\n") || "- (no components)"}`;
			}).join("\n\n"));
		},
	};

	return { topic_map, map_components, map_verdict, map_done, list_topics };
}

/** The teacher's lesson_complete (targeted sessions only): records that the
 *  lesson reached its goal on the target component — evidence kind
 *  lesson-complete, which derives TAUGHT until a later measurement
 *  confirms it held. May be called again after a re-teach. */
export function lessonCompleteTool(ctx: { chatId: string; target: ChatTopicTarget; topicStore: TopicStore }): AgentTool<any> {
	return {
		name: "lesson_complete",
		label: "lesson_complete",
		description: "Report that this lesson reached its goal on the target component of his topic map (see the session context). Call it once the plan's goal is installed and checked — not before. The note says what landed solidly and what stayed shaky in the checks. The component then shows as taught until a later check-up confirms it.",
		parameters: Type.Object({
			note: Type.String({ minLength: 1, description: "What landed solidly, what stayed shaky in the checks. Short." }),
		}),
		execute: async (_id, input) => {
			const record = ctx.topicStore.getTopic(ctx.target.topicId);
			if (!record?.components.some((c) => c.id === ctx.target.componentId)) return invalidInputResult("lesson_complete", ["the target component no longer exists in the topic"]);
			ctx.topicStore.appendEvidence(record.id, {
				componentId: ctx.target.componentId,
				kind: "lesson-complete",
				note: (input as { note: string }).note.trim(),
				chatId: ctx.chatId,
				at: new Date().toISOString(),
			});
			return text("Recorded on his topic map: taught. Close the lesson in a sentence or two — a short check-up will confirm it later.");
		},
	};
}
