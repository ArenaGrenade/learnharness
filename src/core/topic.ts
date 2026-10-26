/**
 * Topic logic — PURE (topics wave, 2026-10-26). Status is derived from the
 * evidence log at read time, never stored (the graph's "derive, don't
 * store" doctrine at the component grain). Browser-safe: the topic page
 * computes the same statuses and What next the server does.
 */
import { CHECKUP_INTERVALS_DAYS, type ComponentStatus, type PaperOutline, type TopicComponent, type TopicEvidence, type TopicRecord, type TopicVerdict } from "./contracts/topic.ts";
import { newMessageId, type LhMarkerMessage } from "./native-messages.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MEASURED: ReadonlySet<TopicEvidence["kind"]> = new Set(["map", "checkup", "session-probe", "practice"]);

export interface ComponentState {
	status: ComponentStatus;
	/** The latest measured verdict (absent when never measured). */
	verdict?: TopicVerdict;
	/** The latest evidence note (measured or taught). */
	note?: string;
	/** When a held component's next check-up falls due. */
	dueAt?: string;
	/** How many consecutive held measurements back the current hold. */
	heldStreak: number;
}

/** One component's derived state. Rules:
 *  - no evidence → unprobed;
 *  - a lesson-complete newer than every measurement → taught (a lesson
 *    followed is not a concept held — the next measurement decides);
 *  - otherwise the latest measured verdict; held becomes due once its
 *    check-up interval (by consecutive held streak) has passed. */
export function componentState(record: Pick<TopicRecord, "evidence">, componentId: string, now: number = Date.now()): ComponentState {
	const evidence = record.evidence.filter((e) => e.componentId === componentId).sort((a, b) => a.at.localeCompare(b.at));
	if (!evidence.length) return { status: "unprobed", heldStreak: 0 };
	const measured = evidence.filter((e) => MEASURED.has(e.kind) && e.verdict);
	const lastMeasured = measured.at(-1);
	const lastLesson = evidence.filter((e) => e.kind === "lesson-complete").at(-1);
	if (lastLesson && (!lastMeasured || lastLesson.at > lastMeasured.at)) {
		return { status: "taught", verdict: lastMeasured?.verdict, note: lastLesson.note, heldStreak: 0 };
	}
	const verdict = lastMeasured!.verdict!;
	if (verdict !== "held") return { status: verdict, verdict, note: lastMeasured!.note, heldStreak: 0 };
	let heldStreak = 0;
	for (let i = measured.length - 1; i >= 0 && measured[i]!.verdict === "held"; i--) heldStreak++;
	const interval = CHECKUP_INTERVALS_DAYS[Math.min(heldStreak, CHECKUP_INTERVALS_DAYS.length) - 1]!;
	const dueAt = new Date(Date.parse(lastMeasured!.at) + interval * DAY_MS).toISOString();
	return { status: now >= Date.parse(dueAt) ? "due" : "held", verdict, note: lastMeasured!.note, dueAt, heldStreak };
}

export function topicStates(record: TopicRecord, now: number = Date.now()): Record<string, ComponentState> {
	return Object.fromEntries(record.components.map((c) => [c.id, componentState(record, c.id, now)]));
}

/** Held ground for prerequisites: the learner can build on it. */
export function groundHeld(status: ComponentStatus): boolean {
	return status === "held" || status === "due" || status === "taught";
}

// ─── map edits ──────────────────────────────────────────────────────────────

export interface MapComponentsInput {
	components: Array<{ key: string; name: string; description: string; prerequisites?: string[]; foundation?: boolean; sources?: Array<{ title: string; url: string }> }>;
	links?: Array<{ component: string; prerequisite: string }>;
	goal?: string;
}

/** Apply an add/link edit. Returns the next components list and the
 *  key → id mapping, or the errors the agent must fix (nothing applied). */
export function applyMapComponents(
	components: readonly TopicComponent[],
	input: MapComponentsInput,
	newId: () => string,
	now: string,
): { ok: true; components: TopicComponent[]; ids: Record<string, string> } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const ids: Record<string, string> = {};
	for (const c of input.components) {
		if (ids[c.key] || components.some((existing) => existing.id === c.key)) errors.push(`key "${c.key}" is used twice or collides with an existing id`);
		ids[c.key] = newId();
	}
	const resolve = (ref: string): string | null => ids[ref] ?? (components.some((c) => c.id === ref) ? ref : null);
	const next = components.map((c) => ({ ...c, prerequisites: [...c.prerequisites] }));
	for (const c of input.components) {
		const prerequisites: string[] = [];
		for (const ref of c.prerequisites ?? []) {
			const id = resolve(ref);
			if (!id) errors.push(`component "${c.key}": unknown prerequisite "${ref}"`);
			else if (!prerequisites.includes(id)) prerequisites.push(id);
		}
		const sources = (c.sources ?? []).filter((s) => /^https?:\/\//.test(s.url)).slice(0, 8).map((s) => ({ title: s.title.trim().slice(0, 300), url: s.url }));
		next.push({ id: ids[c.key]!, name: c.name.trim(), description: c.description.trim(), prerequisites, ...(c.foundation ? { foundation: true } : {}), ...(sources.length ? { sources } : {}), createdAt: now });
	}
	for (const link of input.links ?? []) {
		const target = resolve(link.component), prerequisite = resolve(link.prerequisite);
		if (!target) { errors.push(`link: unknown component "${link.component}"`); continue; }
		if (!prerequisite) { errors.push(`link: unknown prerequisite "${link.prerequisite}"`); continue; }
		const component = next.find((c) => c.id === target)!;
		if (!component.prerequisites.includes(prerequisite)) component.prerequisites.push(prerequisite);
	}
	if (!errors.length) {
		const cycle = findCycle(next);
		if (cycle) errors.push(`prerequisites form a cycle: ${cycle.map((id) => next.find((c) => c.id === id)?.name ?? id).join(" → ")} — a concept cannot rest on itself`);
	}
	return errors.length ? { ok: false, errors } : { ok: true, components: next, ids };
}

/** A prerequisite cycle (as component ids, closed), or null for a DAG. */
export function findCycle(components: readonly TopicComponent[]): string[] | null {
	const byId = new Map(components.map((c) => [c.id, c]));
	const state = new Map<string, 1 | 2>();
	const stack: string[] = [];
	const visit = (id: string): string[] | null => {
		if (state.get(id) === 2) return null;
		if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
		state.set(id, 1); stack.push(id);
		for (const p of byId.get(id)?.prerequisites ?? []) {
			const found = visit(p);
			if (found) return found;
		}
		stack.pop(); state.set(id, 2);
		return null;
	};
	for (const c of components) {
		const found = visit(c.id);
		if (found) return found;
	}
	return null;
}

/** Why the map is not done yet — empty when every branch reaches held
 *  ground: nothing unprobed, and every missing/shaky component that is
 *  not a foundation has had its prerequisites added (the descent rule). */
export function mapGaps(record: TopicRecord, now: number = Date.now()): string[] {
	if (!record.components.length) return ["the map has no components yet"];
	const states = topicStates(record, now);
	const gaps: string[] = [];
	for (const c of record.components) {
		const state = states[c.id]!;
		if (state.status === "unprobed") gaps.push(`${c.name} (${c.id}) is not probed yet`);
		else if ((state.status === "missing" || state.status === "shaky") && !c.foundation && !c.prerequisites.length) {
			gaps.push(`${c.name} (${c.id}) is ${state.status} but has no prerequisites — descend: add what it rests on (map_components) and probe those, or mark it a foundation if nothing underneath is worth probing`);
		}
	}
	return gaps;
}

// ─── What next ──────────────────────────────────────────────────────────────

export type NextKind = "repair" | "checkup" | "confirm" | "learn" | "map";
export interface NextItem {
	kind: NextKind;
	topicId: string;
	componentId?: string;
	/** Short label for the list ("Repair: Softmax"). */
	label: string;
	/** Why it is next. */
	reason: string;
}

const NEXT_ORDER: Record<NextKind, number> = { repair: 0, checkup: 1, confirm: 2, learn: 3, map: 4 };

/** The ordered What next list for one topic:
 *  1. repairs — misconceptions, most-depended-on first (things built on a
 *     wrong belief are unreliable);
 *  2. due check-ups, oldest due first; then taught components to confirm;
 *  3. learn — missing/shaky components whose prerequisites are held ground
 *     (the frontier), most-depended-on first;
 *  4. continue mapping while anything is unprobed or the descent is open. */
export function whatNext(record: TopicRecord, now: number = Date.now()): NextItem[] {
	const states = topicStates(record, now);
	const dependents = (id: string) => record.components.filter((c) => c.prerequisites.includes(id)).length;
	const items: Array<NextItem & { rank: number }> = [];
	for (const c of record.components) {
		const state = states[c.id]!;
		const base = { topicId: record.id, componentId: c.id };
		if (state.status === "misconception") {
			items.push({ ...base, kind: "repair", label: `Repair: ${c.name}`, reason: state.note ?? "A misconception was found.", rank: -dependents(c.id) });
		} else if (state.status === "due") {
			items.push({ ...base, kind: "checkup", label: `Check-up: ${c.name}`, reason: `Held — a check-up has been due since ${(state.dueAt ?? "").slice(0, 10)}; a short check keeps it.`, rank: Date.parse(state.dueAt ?? "") || 0 });
		} else if (state.status === "taught") {
			items.push({ ...base, kind: "confirm", label: `Confirm: ${c.name}`, reason: "Taught — a short check confirms it is held.", rank: 0 });
		} else if ((state.status === "missing" || state.status === "shaky") && c.prerequisites.every((p) => groundHeld(states[p]?.status ?? "unprobed"))) {
			items.push({ ...base, kind: "learn", label: `Learn: ${c.name}`, reason: state.status === "shaky" ? "Shaky — strengthen it; its prerequisites are held." : "Not held yet, and everything it rests on is.", rank: -dependents(c.id) });
		}
	}
	if (mapGaps(record, now).length) items.push({ kind: "map", topicId: record.id, label: "Continue mapping", reason: "Parts of the map are not probed to held ground yet.", rank: 0 });
	return items.sort((a, b) => NEXT_ORDER[a.kind] - NEXT_ORDER[b.kind] || a.rank - b.rank).map(({ rank: _rank, ...item }) => item);
}

/** Map progress for lists: held-ground components out of all. */
export function topicProgress(record: TopicRecord, now: number = Date.now()): { held: number; total: number } {
	const states = topicStates(record, now);
	return { held: record.components.filter((c) => groundHeld(states[c.id]!.status) && states[c.id]!.status !== "taught").length, total: record.components.length };
}

// ─── the targeted session's context marker ──────────────────────────────────

/** The topic-target marker's UI payload (the transcript card). */
export interface TopicTargetDetails {
	topicId: string;
	topicTitle: string;
	componentId: string;
	componentName: string;
	purpose: "learn" | "repair";
}

/** Message[0] of a teaching session started from a topic: what the probe
 *  should CONFIRM rather than search — the component, the evidence the map
 *  already holds on it, and its prerequisites' standing. Flattened to a
 *  user-role message on the wire, so it is bracket-marked as injected
 *  context (the graph-context preamble law). */
export function newTopicTargetMessage(record: TopicRecord, componentId: string, purpose: "learn" | "repair", now: number = Date.now()): LhMarkerMessage {
	const states = topicStates(record, now);
	const component = record.components.find((c) => c.id === componentId);
	if (!component) throw new Error(`unknown component ${componentId}`);
	const state = states[componentId]!;
	const evidence = record.evidence.filter((e) => e.componentId === componentId).map((e) => `- ${e.at.slice(0, 10)} ${e.kind}${e.verdict ? ` → ${e.verdict}` : ""}: ${e.note}`);
	const prerequisites = component.prerequisites.map((id) => {
		const p = record.components.find((c) => c.id === id);
		return `- ${p?.name ?? id}: ${states[id]?.status ?? "unknown"}${states[id]?.note ? ` (${states[id]!.note})` : ""}`;
	});
	const lines = [
		"[Session context] — this session was started from the learner's topic map for ONE component:",
		"",
		`Topic: ${record.title}${record.goal ? ` — goal: ${record.goal}` : ""}`,
		`Target component: ${component.name} — ${component.description}`,
		`Purpose: ${purpose === "repair" ? "REPAIR a misconception found on it" : "LEARN it (it is on his frontier: not held, while what it rests on is)"}`,
		`Current standing: ${state.status}`,
		...(evidence.length ? ["Evidence so far:", ...evidence] : []),
		...(prerequisites.length ? ["What it rests on (and his standing there):", ...prerequisites] : []),
		...(component.sources?.length ? ["Where this concept comes from (teach from these when it helps; the research tool can read them):", ...component.sources.map((s) => `- ${s.title} <${s.url}>`)] : []),
		"",
		"The probe CONFIRMS this picture rather than searching from scratch: re-bracket the target quickly, check the prerequisites only where the evidence is old or thin. probe_done must carry targetVerdict — his standing on the target component before teaching. When the lesson reaches its goal, the teacher calls lesson_complete.",
	];
	const details: TopicTargetDetails = { topicId: record.id, topicTitle: record.title, componentId, componentName: component.name, purpose };
	return { id: newMessageId(), role: "custom", customType: "topic-target", content: lines.join("\n"), display: true, details, timestamp: now };
}

// ─── learn from a paper ─────────────────────────────────────────────────────

/** An arXiv paper reference from what the learner typed: a bare id
 *  (2401.12345, 2401.12345v2, hep-th/9901001) or an arxiv.org / alphaxiv.org
 *  abs/pdf link. null when it is not one. */
export function parseArxivRef(input: string): { arxivId: string; url: string } | null {
	const text = input.trim();
	const id = String.raw`(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)`;
	const bare = new RegExp(`^(?:arxiv:)?${id}$`, "i").exec(text);
	const link = new RegExp(String.raw`^(?:https?:\/\/)?(?:www\.)?(?:arxiv\.org|alphaxiv\.org)\/(?:abs|pdf|overview)\/${id}(?:\.pdf)?\/?(?:[?#].*)?$`, "i").exec(text);
	const arxivId = (bare ?? link)?.[1];
	return arxivId ? { arxivId, url: `https://arxiv.org/abs/${arxivId}` } : null;
}

/** The paper-outline marker's UI payload. */
export interface PaperOutlineDetails {
	outline: PaperOutline;
}

/** Message[0] of a paper topic's mapping conversation: the traced outline
 *  — the mapper's first draft of components, with their sources. */
export function newPaperOutlineMessage(outline: PaperOutline, now: number = Date.now()): LhMarkerMessage {
	const name = (key: string) => outline.concepts.find((c) => c.key === key)?.name ?? key;
	const lines = [
		`[Session context] — this topic is a research paper, traced through its citations before mapping:`,
		"",
		`Paper: ${outline.title}`,
		`Summary: ${outline.summary}`,
		"",
		"Concept outline (a first draft of the map — confirm with him which parts he wants, then lay out components from it, carrying each concept's sources in map_components):",
		...outline.concepts.map((c) => `- [${c.key}] ${c.name}: ${c.description}${c.prerequisites.length ? ` — rests on: ${c.prerequisites.map(name).join(", ")}` : ""}${c.sources.length ? ` — sources: ${c.sources.map((s) => `${s.title} <${s.url}>`).join("; ")}` : ""}`),
		"",
		`Papers read (${outline.papers.length}): ${outline.papers.map((p) => `${p.title} (depth ${p.depth})`).join("; ")}`,
	];
	const details: PaperOutlineDetails = { outline };
	return { id: newMessageId(), role: "custom", customType: "paper-outline", content: lines.join("\n"), display: true, details, timestamp: now };
}
