/**
 * Topics — the server seam (topics wave, 2026-10-26): creating a topic with
 * its mapping conversation, starting check-ups, deleting. Status, progress
 * and What next are pure core (core/topic.ts) and computed by whoever
 * reads a record — the routes serve records only.
 */
import { stores } from "./stores.ts";
import { stampSessionModel } from "./chats.ts";
import type { ComponentLinks, TopicRecord, TopicVerdict } from "../core/contracts.ts";
import { resolveTargetId } from "../core/chains.ts";
import { getGraph } from "../core/graph.ts";
import { birthSessionOf } from "../core/session-clusters.ts";
import { componentState, newPaperOutlineMessage, newTopicTargetMessage, parseArxivRef } from "../core/topic.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { runPaperTracer } from "../agent/subagents/paper-tracer.ts";
import { createWebTools } from "../agent/tools/web.ts";
import { createPdfReadTools } from "../agent/tools/pdf-read.ts";
import { openAlphaxivTools } from "./mcp/alphaxiv.ts";
import { searchProvider } from "./search.ts";

export class TopicRequestError extends Error {
	constructor(message: string, readonly status: number) { super(message); }
}

export const newTopicId = () => `topic_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;

/** A new topic + its mapping conversation (kind "topic", mode "map"). The
 *  client opens the chat with the learner's target as the first message. */
export function createTopic(title: string): { topic: TopicRecord; chatId: string; paper: boolean } {
	const clean = title.trim();
	if (!clean) throw new TopicRequestError("Name the topic you want to learn.", 400);
	if (clean.length > 200) throw new TopicRequestError("Keep the topic name under 200 characters.", 400);
	// An arXiv link or id starts a paper topic: the citation trace runs
	// first, and the mapping conversation opens with its outline.
	const paper = parseArxivRef(clean);
	const id = newTopicId();
	const name = paper ? `arXiv ${paper.arxivId}` : clean;
	const chat = stores.chatStore.createChat(name, "topic", { topicId: id, mode: "map" });
	stampSessionModel(chat.id);
	const topic = stores.topicStore.createTopic({
		id, title: name, mapChatId: chat.id,
		...(paper ? { source: { kind: "paper", arxivId: paper.arxivId, url: paper.url, status: "tracing", progress: "Starting…", startedAt: new Date().toISOString() } } : {}),
	});
	if (paper) void tracePaper(id, runPaperTracer);
	return { topic, chatId: chat.id, paper: !!paper };
}

/** Run (or re-run) the citation trace for a paper topic, in the background:
 *  progress lands on the topic (topics-changed), the outline becomes the
 *  mapping conversation's opening context. Never throws. The tracer is
 *  injectable (tests script it). */
export async function tracePaper(topicId: string, tracer: typeof runPaperTracer = runPaperTracer): Promise<void> {
	const topic = getTopic(topicId);
	const source = topic?.source;
	if (!topic || !source) return;
	stores.topicStore.updateSource(topicId, { status: "tracing", progress: "Starting…", error: undefined, startedAt: new Date().toISOString(), finishedAt: undefined });
	const spec = resolveRoleSpec("researcher", stores.settingsStore.readSettings());
	if (!spec && tracer === runPaperTracer) {
		stores.topicStore.updateSource(topicId, { status: "error", error: "No model is set for research. Set the Cheap model slot in Settings → Agent, then retry.", progress: undefined });
		return;
	}
	const pdfDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-trace-"));
	const alphaxiv = await openAlphaxivTools().catch(() => null);
	try {
		const tools = alphaxiv
			? Object.fromEntries(alphaxiv.tools.map((t) => [t.name, t]))
			: { ...createWebTools(searchProvider), ...createPdfReadTools(pdfDir) };
		const outline = await tracer({
			arxivId: source.arxivId,
			url: source.url,
			engine: spec ? piEngineForSpec(spec) : undefined,
			tools,
			usesAlphaxiv: !!alphaxiv,
			onStep: (step, used) => { stores.topicStore.updateSource(topicId, { progress: `Step ${step}${used && used !== "(none)" ? ` · ${used.replace(/alphaxiv_/g, "")}` : ""}` }); },
		});
		stores.topicStore.updateSource(topicId, { status: "ready", outline, progress: undefined, finishedAt: new Date().toISOString() }, outline.title);
		// The mapper's opening context — only into an untouched conversation.
		const chat = stores.chatStore.getChat(topic.mapChatId);
		if (chat && !chat.messages.some((m) => m.role === "user" || m.role === "assistant")) {
			stores.chatStore.saveMessages(chat.id, [newPaperOutlineMessage(outline)]);
			stores.chatStore.renameChat(chat.id, outline.title.slice(0, 200));
		}
	} catch (err) {
		stores.topicStore.updateSource(topicId, { status: "error", error: `The trace did not finish: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400), progress: undefined, finishedAt: new Date().toISOString() });
	} finally {
		await alphaxiv?.close();
		await fs.rm(pdfDir, { recursive: true, force: true });
	}
}

export function listTopics(): TopicRecord[] {
	return stores.topicStore.listTopics();
}

export function getTopic(id: string): TopicRecord | null {
	try { return stores.topicStore.getTopic(id); } catch { return null; }
}

/** A short check-up conversation for one component. */
export function startCheckup(topicId: string, componentId: string): { chatId: string } {
	const topic = getTopic(topicId);
	if (!topic) throw new TopicRequestError("Topic not found.", 404);
	const component = topic.components.find((c) => c.id === componentId);
	if (!component) throw new TopicRequestError("Component not found.", 404);
	const chat = stores.chatStore.createChat(`Check-up: ${component.name}`, "topic", { topicId, mode: "checkup", componentId });
	stampSessionModel(chat.id);
	return { chatId: chat.id };
}

/** A TEACHING session for one component (learn the frontier or repair a
 *  misconception): a normal session — probe, plan, teach, extraction into
 *  the graph — whose message[0] is the topic-target context marker. Its
 *  probe_done and lesson_complete report back to the topic. */
export function startLearning(topicId: string, componentId: string, purpose: "learn" | "repair"): { chatId: string; prompt: string } {
	const topic = getTopic(topicId);
	if (!topic) throw new TopicRequestError("Topic not found.", 404);
	const component = topic.components.find((c) => c.id === componentId);
	if (!component) throw new TopicRequestError("Component not found.", 404);
	const chat = stores.chatStore.createChat(component.name, undefined, undefined, { topicId, componentId, purpose });
	stampSessionModel(chat.id);
	stores.chatStore.saveMessages(chat.id, [newTopicTargetMessage(topic, componentId, purpose)]);
	const status = componentState(topic, componentId).status;
	const prompt = purpose === "repair"
		? `I want to fix my understanding of ${component.name}.`
		: status === "shaky" ? `I want to strengthen my understanding of ${component.name}.` : `I want to learn ${component.name}: ${component.description}`;
	return { chatId: chat.id, prompt };
}

/** Delete a topic and its own conversations (mapping + check-ups). Teaching
 *  sessions started from it are real sessions and stay. */
export function deleteTopic(id: string): boolean {
	if (!getTopic(id)) return false;
	for (const summary of stores.chatStore.listChats()) {
		if (summary.kind !== "topic") continue;
		const chat = stores.chatStore.getChat(summary.id);
		if (chat?.topic?.topicId === id) stores.chatStore.deleteChat(summary.id);
	}
	return stores.topicStore.deleteTopic(id);
}

/** Every component's links (topics wave, item 1): the teaching sessions
 *  started from the topic for it, and the graph propositions those
 *  sessions gave birth to. Derived per read — chats and the graph are the
 *  truth. Components with nothing linked are absent. */
export function topicLinks(topicId: string): Record<string, ComponentLinks> {
	const links: Record<string, ComponentLinks> = {};
	const bySession = new Map<string, string>();
	for (const summary of stores.chatStore.listChats()) {
		if (summary.kind && summary.kind !== "teach") continue;
		const chat = stores.chatStore.getChat(summary.id);
		const target = chat?.topicTarget;
		if (!chat || !target || target.topicId !== topicId) continue;
		const entry = (links[target.componentId] ??= { sessions: [], propositions: [] });
		entry.sessions.push({ chatId: chat.id, title: chat.title, purpose: target.purpose });
		bySession.set(chat.id, target.componentId);
	}
	if (!bySession.size) return links;
	for (const node of getGraph(stores.graphStore).nodes) {
		const componentId = bySession.get(birthSessionOf(node) ?? "");
		if (componentId) links[componentId]!.propositions.push({ id: node.id, name: node.name, statement: node.statement });
	}
	return links;
}

/** The owner's practice mapping (2026-10-26): solved → held; solved with
 *  hints or surrendered → shaky (one failed problem is not proof a concept
 *  is missing); moved on / dismissed → no evidence. */
export function practiceVerdict(outcome: string): TopicVerdict | null {
	return outcome === "solved" ? "held" : outcome === "solvedWithHints" || outcome === "surrendered" ? "shaky" : null;
}

/** A practice problem concluded: record its outcome on every topic
 *  component whose linked propositions include one of its targets. */
export function recordPracticeEvidence(chatId: string, targets: readonly string[], outcome: string): number {
	const verdict = practiceVerdict(outcome);
	if (!verdict || !targets.length) return 0;
	const nodes = stores.graphStore.readNodes();
	const ids = new Set(targets.map((t) => resolveTargetId(t, nodes)).filter((id): id is string => id !== null));
	if (!ids.size) return 0;
	let recorded = 0;
	for (const topic of stores.topicStore.listTopics()) {
		for (const [componentId, link] of Object.entries(topicLinks(topic.id))) {
			const hit = link.propositions.filter((p) => ids.has(p.id));
			if (!hit.length) continue;
			stores.topicStore.appendEvidence(topic.id, {
				componentId, kind: "practice", verdict,
				note: `Practice problem ${outcome === "solved" ? "solved" : outcome === "solvedWithHints" ? "solved with hints" : "given up"} (targets: ${hit.map((p) => p.name).join(", ")}).`,
				chatId, at: new Date().toISOString(),
			});
			recorded++;
		}
	}
	return recorded;
}
