/** Topic-targeted teaching sessions and check-ups (topics wave, 2026-10-26). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TopicEvidence, TopicRecord, TopicStore } from "../src/core/index.ts";
import { componentState, newTopicTargetMessage, nativeInputCause } from "../src/core/index.ts";
import { probeDoneTool } from "../src/agent/tools/probe.ts";
import { lessonCompleteTool } from "../src/agent/tools/topic.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { projectView } from "../src/core/view.ts";
import { createTopic, getTopic, startCheckup, startLearning } from "../src/server/topics.ts";
import { stores } from "../src/server/stores.ts";

const record = (): TopicRecord => ({
	id: "topic_t", title: "Transformers", goal: "Implement attention", mapChatId: "chat_map",
	components: [
		{ id: "c_att", name: "Attention", description: "weighted averaging of values", prerequisites: ["c_sm"], createdAt: "2026-10-01T00:00:00.000Z" },
		{ id: "c_sm", name: "Softmax", description: "normalized exponentials", prerequisites: [], createdAt: "2026-10-01T00:00:00.000Z" },
	],
	evidence: [
		{ componentId: "c_att", kind: "map", verdict: "missing", note: "never met it", chatId: "chat_map", at: "2026-10-02T00:00:00.000Z" },
		{ componentId: "c_sm", kind: "map", verdict: "held", note: "solid", chatId: "chat_map", at: "2026-10-02T00:00:00.000Z" },
	],
	createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
});
function memory(r: TopicRecord) {
	const appended: TopicEvidence[] = [];
	const store = { getTopic: () => r, appendEvidence: (_id: string, e: TopicEvidence) => { appended.push(e); r.evidence.push(e); return r; } } as unknown as TopicStore;
	return { store, appended };
}
const call = async (tool: { execute: (...a: any[]) => Promise<any> }, input: unknown) => {
	const out = await tool.execute("call", input, undefined);
	return { text: out.content[0].text as string, details: out.details, isError: out.isError === true };
};
const assessment = { strands: [{ strand: "attention", assessment: "floor: dot products; ceiling: scaling" }] };

describe("targeted probe_done", () => {
	it("requires targetVerdict in its schema and records it as session-probe evidence", async () => {
		const r = record();
		const { store, appended } = memory(r);
		const chat = { messages: [] };
		const tools = probeDoneTool({ chatId: "chat_s", chatStore: { getChat: () => chat } as never, deliver: () => {}, topicTarget: { topicId: "topic_t", componentId: "c_att", purpose: "learn" }, topicStore: store });
		const schema = tools.probe_done!.parameters as { required?: string[] };
		assert(schema.required?.includes("targetVerdict"));
		const refused = await call(tools.probe_done!, { assessment });
		assert.match(JSON.stringify(refused.details), /needs targetVerdict/);
		assert.equal(appended.length, 0);
		await call(tools.probe_done!, { assessment, targetVerdict: { verdict: "shaky", note: "gets the dot product, not the scaling" } });
		assert.deepEqual({ kind: appended[0]!.kind, verdict: appended[0]!.verdict, chat: appended[0]!.chatId }, { kind: "session-probe", verdict: "shaky", chat: "chat_s" });
		assert.equal(componentState(r, "c_att").status, "shaky");
	});

	it("untargeted sessions keep the plain schema", () => {
		const tools = probeDoneTool({ chatId: "chat_s", chatStore: { getChat: () => ({ messages: [] }) } as never, deliver: () => {} });
		assert(!(tools.probe_done!.parameters as { required?: string[] }).required?.includes("targetVerdict"));
	});
});

describe("lesson_complete", () => {
	it("is registered only for targeted teachers and records taught", async () => {
		const r = record();
		const { store } = memory(r);
		const base = { chatId: "chat_s", chatStore: { getChat: () => null } as never, jobStore: {} as never, spawn: () => {} };
		assert(!("lesson_complete" in createTeacherTools(base)));
		assert("lesson_complete" in createTeacherTools({ ...base, topicTarget: { topicId: "topic_t", componentId: "c_att", purpose: "learn" }, topicStore: store }));
		const out = await call(lessonCompleteTool({ chatId: "chat_s", target: { topicId: "topic_t", componentId: "c_att", purpose: "learn" }, topicStore: store }), { note: "scaling still shaky" });
		assert.match(out.text, /taught/);
		assert.equal(componentState(r, "c_att").status, "taught");
	});
});

describe("the topic-target marker", () => {
	it("carries the component, its evidence and its prerequisites' standing; renders as a card; is neutral input", () => {
		const marker = newTopicTargetMessage(record(), "c_att", "learn", Date.parse("2026-10-03T00:00:00.000Z"));
		assert.match(marker.content, /^\[Session context\]/);
		assert.match(marker.content, /Target component: Attention — weighted averaging of values/);
		assert.match(marker.content, /2026-10-02 map → missing: never met it/);
		assert.match(marker.content, /- Softmax: held \(solid\)/);
		assert.match(marker.content, /probe_done must carry targetVerdict/);
		assert.equal(nativeInputCause(marker as never, []), "neutral");
		const view = projectView([{ ...marker }] as never);
		assert.equal(view[0]!.parts[0]!.type, "data-topic-target");
		assert.throws(() => newTopicTargetMessage(record(), "c_nope", "learn"), /unknown component/);
	});
});

describe("starting sessions from a topic (scratch data)", () => {
	it("creates the topic + mapping chat, check-ups, and targeted teaching sessions", () => {
		const { topic, chatId } = createTopic("  Transformers ");
		const mapChat = stores.chatStore.getChat(chatId)!;
		assert.equal(mapChat.kind, "topic");
		assert.deepEqual(mapChat.topic, { topicId: topic.id, mode: "map" });
		assert.throws(() => createTopic("   "), /Name the topic/);
		stores.topicStore.saveComponents(topic.id, record().components);
		const check = stores.chatStore.getChat(startCheckup(topic.id, "c_sm").chatId)!;
		assert.deepEqual(check.topic, { topicId: topic.id, mode: "checkup", componentId: "c_sm" });
		assert.equal(check.title, "Check-up: Softmax");
		const learn = startLearning(topic.id, "c_att", "learn");
		const session = stores.chatStore.getChat(learn.chatId)!;
		assert.equal(session.kind, undefined, "a real teaching session");
		assert.deepEqual(session.topicTarget, { topicId: topic.id, componentId: "c_att", purpose: "learn" });
		assert.equal((session.messages[0] as { customType?: string }).customType, "topic-target");
		assert.equal(learn.prompt, "I want to learn Attention: weighted averaging of values");
		assert.equal(startLearning(topic.id, "c_att", "repair").prompt, "I want to fix my understanding of Attention.");
		assert.throws(() => startLearning(topic.id, "c_missing", "learn"), /Component not found/);
		assert.equal(getTopic("topic_nope"), null);
	});
});
