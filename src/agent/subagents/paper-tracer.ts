/**
 * THE CITATION TRACER (learn-from-a-paper, owner design 2026-10-26): reads a
 * paper, picks out its core methods and ideas, and follows the citations
 * behind each (bounded: 2 levels, ~10 papers) until it reaches where each
 * idea originates. Its one deliverable is a concept outline — the mapper's
 * first draft of the topic's components, each with the papers it comes
 * from. Read tools arrive from the composition root: the alphaXiv paper
 * tools when the key is set, otherwise arXiv pages and PDFs.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PaperOutline } from "../../core/contracts.ts";
import { findCycle } from "../../core/topic.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export const TRACE_MAX_DEPTH = 2;
export const TRACE_MAX_PAPERS = 10;

const ref = Type.Object({ title: Type.String({ minLength: 1 }), url: Type.String({ minLength: 1, description: "https link — https://arxiv.org/abs/<id> for arXiv papers." }) });
export const outlineInput = Type.Object({
	title: Type.String({ minLength: 1, description: "The paper's title." }),
	summary: Type.String({ minLength: 1, description: "Two or three sentences: what the paper does and the ideas it rests on." }),
	concepts: Type.Array(
		Type.Object({
			key: Type.String({ minLength: 1, description: "Short unique handle, e.g. 'attention'." }),
			name: Type.String({ minLength: 1, description: "Concept name — the size one teaching session can take." }),
			description: Type.String({ minLength: 1, description: "One sentence: what understanding it means." }),
			prerequisites: Type.Array(Type.String(), { description: "Keys of concepts in this outline it rests on." }),
			sources: Type.Array(ref, { description: "The papers this concept comes from — where it originates, not just where it is used." }),
		}),
		{ minItems: 1, description: "The core methods and ideas, as a prerequisite DAG ending in the paper's own contribution." },
	),
	papers: Type.Array(Type.Object({ title: Type.String({ minLength: 1 }), url: Type.String({ minLength: 1 }), depth: Type.Integer({ minimum: 0, maximum: TRACE_MAX_DEPTH }) }), { description: "Every paper you actually read, with its citation depth (0 = the paper itself)." }),
});

const INSTRUCTIONS = `You trace a research paper to the core of its methods and ideas, for a learner who wants to understand it. Your output is a concept outline that a tutor will turn into a learning map.

Work like this:
1. Read the paper (its full text when you can). Identify its CORE methods and ideas — the handful a reader must understand to follow the paper's contribution — and what each rests on.
2. Trace citations behind each core idea: open the cited papers that introduced it (not every reference — the ones the idea comes from), and from those, at most one level further. Stop at ${TRACE_MAX_DEPTH} citation levels below the paper and ${TRACE_MAX_PAPERS} papers in total. Prefer the original source of an idea over surveys and follow-ups.
3. Submit the outline with submit_outline:
   - concepts are the size one teaching session can take ("scaled dot-product attention", "layer normalization") — never a whole field, never a single fact;
   - prerequisites form a DAG from foundations up to the paper's own contribution (which is a concept too);
   - each concept's sources are the papers it COMES FROM, with https links (arXiv: https://arxiv.org/abs/<id>);
   - papers lists every paper you actually read, with its depth.

Be economical: skim for structure, read closely only what decides a concept or an edge. Never invent papers, titles or links — cite only what you opened. If a cited paper cannot be opened, keep the concept and cite what you could read.`;

export interface PaperTracerOptions {
	arxivId: string;
	url: string;
	engine: PiEngine | undefined;
	/** The read tools: alphaXiv paper tools, or web_fetch/web_fetch_pdf + pdf tools. */
	tools: Record<string, AgentTool<any>>;
	usesAlphaxiv: boolean;
	signal?: AbortSignal;
	onStep?: (step: number, tools: string, usage: Usage) => void;
}

/** Semantic checks the schema cannot express: keys unique, prerequisites
 *  resolve, the outline is a DAG, sources are links. */
export function outlineProblems(outline: PaperOutline): string | null {
	const keys = new Set<string>();
	for (const c of outline.concepts) {
		if (keys.has(c.key)) return `concept key "${c.key}" is used twice`;
		keys.add(c.key);
	}
	for (const c of outline.concepts) {
		const unknown = c.prerequisites.find((p) => !keys.has(p));
		if (unknown) return `concept "${c.key}" rests on unknown key "${unknown}"`;
		const bad = c.sources.find((s) => !/^https?:\/\//.test(s.url));
		if (bad) return `concept "${c.key}" has a source without an http(s) link: ${bad.title}`;
	}
	const cycle = findCycle(outline.concepts.map((c) => ({ id: c.key, name: c.name, description: "", prerequisites: c.prerequisites, createdAt: "" })));
	if (cycle) return `prerequisites form a cycle: ${cycle.join(" → ")}`;
	if (outline.papers.length > TRACE_MAX_PAPERS + 2) return `you read ${outline.papers.length} papers — the bound is ${TRACE_MAX_PAPERS}; list only what you read`;
	return null;
}

export async function runPaperTracer(opts: PaperTracerOptions): Promise<PaperOutline> {
	const how = opts.usesAlphaxiv
		? "Use the alphaxiv_* tools: alphaxiv_get_paper_content for the paper and each cited paper (ask for the full text when you need the references or exact definitions), alphaxiv_answer_pdf_queries for targeted questions, alphaxiv_discover_papers to find a cited paper's arXiv id from its title."
		: `Read arXiv papers as PDFs: web_fetch_pdf on https://arxiv.org/pdf/<id>, then the pdf tools to read sections and the reference list. web_fetch reads abstract pages (https://arxiv.org/abs/<id>) and other pages.`;
	return runSubmitAgent<PaperOutline>({
		role: "researcher",
		toolName: "submit_outline",
		toolDescription: "Submit the concept outline — your one deliverable. Refused with the problem when keys repeat, a prerequisite is unknown, prerequisites cycle, or a source has no link.",
		parameters: outlineInput,
		fill: (input) => input as PaperOutline,
		validate: outlineProblems,
		systemPrompt: INSTRUCTIONS,
		prompt: `Trace this paper: ${opts.url} (arXiv ${opts.arxivId}).\n\n${how}`,
		engine: opts.engine,
		signal: opts.signal,
		extraTools: opts.tools,
		maxTurns: 40,
		neverSubmitted: "The tracer never submitted an outline.",
		onStep: (usage, _model, step, _finish, tools) => opts.onStep?.(step, tools, usage),
	});
}
