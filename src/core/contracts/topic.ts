/**
 * Topic contracts (topics wave, 2026-10-26 — owner design).
 *
 * A TOPIC is a learning target ("Transformers") with a MAP: the concepts
 * (components) it depends on, as a prerequisite DAG, plus an APPEND-ONLY
 * EVIDENCE LOG of the learner's measured standing on each. Status is
 * DERIVED from the log at read time (core/topic.ts) — never stored. This
 * deliberately reverses the 2026-09-29 "no understanding levels anywhere"
 * ruling, by owner decision, at the COMPONENT grain only: the knowledge
 * graph's propositions still carry no levels.
 *
 * Components are CONCEPTS — the size one teaching session can take — not
 * graph propositions. A component's graph link is derived (the propositions
 * born in sessions targeted at it), never stored.
 *
 * One file per topic (data/topics/<id>.json), written only by the topic
 * store. The mapping conversation is a chat of kind "topic" that points
 * back here (ChatRecord.topic).
 */
import { Type } from "typebox";

/** A measured standing on one component. */
export type TopicVerdict = "held" | "shaky" | "misconception" | "missing";
export const TOPIC_VERDICTS: readonly TopicVerdict[] = ["held", "shaky", "misconception", "missing"];

/** Where a piece of evidence came from. map = the topic probe; checkup = a
 *  short check-up conversation; session-probe = a targeted teaching
 *  session's probe_done; lesson-complete = a targeted session's teacher
 *  concluded the lesson (taught, pending confirmation); practice = a
 *  practice problem targeting the component's propositions concluded. */
export type TopicEvidenceKind = "map" | "checkup" | "session-probe" | "lesson-complete" | "practice";

/** The derived status the map renders. */
export type ComponentStatus = "unprobed" | "held" | "due" | "taught" | "shaky" | "misconception" | "missing";

export interface TopicComponent {
	/** "c_" + short random id (store-assigned). */
	id: string;
	/** Short concept name — the map label ("Scaled dot-product attention"). */
	name: string;
	/** One sentence: what holding this concept means. */
	description: string;
	/** Components this one rests on (DAG edges: prerequisite → this). */
	prerequisites: string[];
	/** A starting fact with nothing underneath worth probing: a missing
	 *  foundation is taught as-is, not descended into. */
	foundation?: boolean;
	/** Papers this concept comes from (topics from a paper — the traced
	 *  outline's sources). Teaching sessions for it receive them. */
	sources?: PaperRef[];
	createdAt: string;
}

/** A paper as the tracer and mapper cite it. */
export interface PaperRef {
	title: string;
	url: string;
}

/** The citation tracer's deliverable: the paper's core methods and ideas
 *  as a concept DAG, each with the papers it comes from. */
export interface PaperOutline {
	title: string;
	summary: string;
	concepts: Array<{ key: string; name: string; description: string; prerequisites: string[]; sources: PaperRef[] }>;
	/** Every paper read, with its citation depth (0 = the paper itself). */
	papers: Array<PaperRef & { depth: number }>;
}

/** A topic started from a paper (learn-from-a-paper, 2026-10-26). */
export interface TopicPaperSource {
	kind: "paper";
	arxivId: string;
	url: string;
	status: "tracing" | "ready" | "error";
	/** The latest progress line while tracing. */
	progress?: string;
	error?: string;
	outline?: PaperOutline;
	startedAt: string;
	finishedAt?: string;
}

export interface TopicEvidence {
	componentId: string;
	kind: TopicEvidenceKind;
	/** Absent only on lesson-complete (taught carries no measured verdict). */
	verdict?: TopicVerdict;
	/** Where the floor and ceiling sit, misconceptions found — the agent's
	 *  read from the evidence (free-form, short). */
	note: string;
	/** The chat the evidence came from. */
	chatId: string;
	at: string;
}

export interface TopicRecord {
	/** "topic_" + short random id. */
	id: string;
	/** The target as the learner named it (the list label). */
	title: string;
	/** The target made concrete by the mapper (absent until it says). */
	goal?: string;
	/** The mapping conversation (chat kind "topic", mode "map"). */
	mapChatId: string;
	components: TopicComponent[];
	evidence: TopicEvidence[];
	/** Set when the mapper concluded with every branch at held ground. */
	mappedAt?: string;
	/** A topic started from a paper: the citation trace and its outline. */
	source?: TopicPaperSource;
	createdAt: string;
	updatedAt: string;
}

/** ChatRecord.topic — which topic a kind:"topic" chat serves, and how. */
export interface ChatTopicLink {
	topicId: string;
	/** map = the topic probe; checkup = a short check of one component. */
	mode: "map" | "checkup";
	/** The component under check-up (mode "checkup" only). */
	componentId?: string;
}

/** ChatRecord.topicTarget — a TEACHING session started from a topic for one
 *  component (learn the frontier, or repair a misconception). Its probe
 *  reports a verdict and its teacher reports lesson completion back to the
 *  topic's evidence log. */
export interface ChatTopicTarget {
	topicId: string;
	componentId: string;
	purpose: "learn" | "repair";
}

/** Spaced check-up intervals after consecutive held confirmations (days):
 *  1st held → due in 7, 2nd → 21, 3rd → 60, then every 150. A miss resets. */
export const CHECKUP_INTERVALS_DAYS = [7, 21, 60, 150] as const;

// ─── Mapper tool inputs (TypeBox — the boundary schema IS the contract) ─────

export const mapComponentsInput = Type.Object({
	components: Type.Array(
		Type.Object({
			key: Type.String({ minLength: 1, description: "Your handle for a NEW component, unique in this call (e.g. 'softmax'). Prerequisites may name these keys or existing component ids." }),
			name: Type.String({ minLength: 1, description: "Short concept name, e.g. 'Softmax as normalized exponentials'." }),
			description: Type.String({ minLength: 1, description: "One sentence: what holding this concept means." }),
			prerequisites: Type.Optional(Type.Array(Type.String(), { description: "Keys from this call or existing component ids this concept rests on." })),
			foundation: Type.Optional(Type.Boolean({ description: "true for a starting fact with nothing underneath worth probing." })),
			sources: Type.Optional(Type.Array(Type.Object({ title: Type.String(), url: Type.String() }), { description: "Papers the concept comes from (from the paper outline, when there is one)." })),
		}),
		{ description: "New components to add to the map." },
	),
	links: Type.Optional(Type.Array(
		Type.Object({
			component: Type.String({ description: "Existing component id (or a key from this call) that gains a prerequisite." }),
			prerequisite: Type.String({ description: "Existing component id (or a key from this call) it rests on." }),
		}),
		{ description: "Extra prerequisite edges between components (e.g. a new prerequisite for an existing component after a miss)." },
	)),
	goal: Type.Optional(Type.String({ description: "The target made concrete, once the learner has said what he wants (one sentence)." })),
});

export const mapVerdictInput = Type.Object({
	component: Type.String({ minLength: 1, description: "The component id (as topic_map shows it)." }),
	verdict: Type.Union(TOPIC_VERDICTS.map((v) => Type.Literal(v)), { description: "held | shaky | misconception | missing — from the evidence of your questions." }),
	note: Type.String({ minLength: 1, description: "Floor (what he reliably gets right), ceiling (where it runs out), misconceptions found. Short." }),
});

/** What a component links to in the rest of the app — DERIVED on read,
 *  never stored: the teaching sessions targeted at it and the graph
 *  propositions born in those sessions. */
export interface ComponentLinks {
	sessions: Array<{ chatId: string; title: string; purpose: "learn" | "repair" }>;
	propositions: Array<{ id: string; name: string; statement: string }>;
}
