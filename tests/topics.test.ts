/** Topics (topics wave, 2026-10-26): pure status + What next, the store, the mapper tools. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TopicComponent, TopicEvidence, TopicRecord, TopicStore } from "../src/core/index.ts";
import { applyMapComponents, componentState, findCycle, mapGaps, topicProgress, whatNext } from "../src/core/topic.ts";
import { topicStore } from "../src/store/topics.ts";
import { renderTopicMap, topicTools } from "../src/agent/tools/topic.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { createMapperTools } from "../src/agent/tools.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (days: number) => new Date(T0 + days * DAY).toISOString();
const comp = (id: string, prerequisites: string[] = [], extra: Partial<TopicComponent> = {}): TopicComponent => ({ id, name: id.toUpperCase(), description: `holds ${id}`, prerequisites, createdAt: iso(0), ...extra });
const ev = (componentId: string, kind: TopicEvidence["kind"], verdict: TopicEvidence["verdict"], day: number): TopicEvidence => ({ componentId, kind, ...(verdict ? { verdict } : {}), note: `${kind} ${verdict ?? "taught"}`, chatId: "chat_x", at: iso(day) });
const topic = (components: TopicComponent[], evidence: TopicEvidence[] = []): TopicRecord => ({ id: "topic_t", title: "T", mapChatId: "chat_map", components, evidence, createdAt: iso(0), updatedAt: iso(0) });

describe("component status — derived from evidence, never stored", () => {
	it("unprobed → measured verdicts; the latest measurement wins", () => {
		const t = topic([comp("a")], [ev("a", "map", "missing", 1), ev("a", "session-probe", "shaky", 2)]);
		assert.equal(componentState(topic([comp("a")]), "a").status, "unprobed");
		assert.equal(componentState(t, "a", T0 + 3 * DAY).status, "shaky");
	});

	it("a lesson completed after the last measurement is taught, until a measurement confirms", () => {
		const taught = topic([comp("a")], [ev("a", "map", "missing", 1), ev("a", "lesson-complete", undefined, 2)]);
		assert.equal(componentState(taught, "a", T0 + 3 * DAY).status, "taught");
		taught.evidence.push(ev("a", "checkup", "held", 4));
		assert.equal(componentState(taught, "a", T0 + 5 * DAY).status, "held");
	});

	it("held falls due at widening intervals by consecutive held streak; a miss resets", () => {
		const t = topic([comp("a")], [ev("a", "map", "held", 0)]);
		assert.equal(componentState(t, "a", T0 + 6 * DAY).status, "held");
		assert.equal(componentState(t, "a", T0 + 7 * DAY).status, "due");
		t.evidence.push(ev("a", "checkup", "held", 7));
		assert.equal(componentState(t, "a", T0 + 27 * DAY).status, "held", "2nd hold → 21 days");
		assert.equal(componentState(t, "a", T0 + 28 * DAY).status, "due");
		t.evidence.push(ev("a", "checkup", "held", 28), ev("a", "checkup", "held", 88));
		assert.equal(componentState(t, "a", T0 + 88 * DAY).heldStreak, 4);
		assert.equal(componentState(t, "a", T0 + 237 * DAY).status, "held", "4th+ hold → 150 days");
		assert.equal(componentState(t, "a", T0 + 238 * DAY).status, "due");
		t.evidence.push(ev("a", "checkup", "shaky", 240), ev("a", "map", "held", 241));
		assert.equal(componentState(t, "a", T0 + 241 * DAY).heldStreak, 1, "the miss reset the streak");
	});
});

describe("map edits — keys resolve, references must exist, prerequisites stay a DAG", () => {
	let n = 0;
	const id = () => `c_${++n}`;
	it("adds components by key and links existing ones", () => {
		const out = applyMapComponents([comp("c_a")], { components: [{ key: "soft", name: "Softmax", description: "d", prerequisites: ["c_a"] }], links: [{ component: "c_a", prerequisite: "soft" }] }, id, iso(0));
		assert.equal(out.ok, false, "a→soft and soft→a is a cycle");
		const ok = applyMapComponents([comp("c_a")], { components: [{ key: "soft", name: "Softmax", description: "d" }], links: [{ component: "c_a", prerequisite: "soft" }] }, id, iso(0));
		assert(ok.ok);
		const softId = ok.ids.soft!;
		assert.deepEqual(ok.components.find((c) => c.id === "c_a")!.prerequisites, [softId]);
	});

	it("refuses unknown references with nothing applied", () => {
		const out = applyMapComponents([], { components: [{ key: "x", name: "X", description: "d", prerequisites: ["nope"] }] }, id, iso(0));
		assert(!out.ok); assert.match(out.errors[0]!, /unknown prerequisite "nope"/);
		assert.equal(findCycle([comp("a", ["b"]), comp("b")]), null);
		assert.deepEqual(findCycle([comp("a", ["b"]), comp("b", ["a"])]), ["a", "b", "a"]);
	});
});

describe("the descent rule and What next", () => {
	it("map_done gaps: unprobed components, and missing/shaky without prerequisites unless a foundation", () => {
		const t = topic([comp("target", ["a"]), comp("a"), comp("f", [], { foundation: true })], [ev("target", "map", "missing", 1), ev("a", "map", "shaky", 1), ev("f", "map", "missing", 1)]);
		const gaps = mapGaps(t, T0 + 2 * DAY);
		assert.equal(gaps.length, 1);
		assert.match(gaps[0]!, /A \(a\) is shaky but has no prerequisites — descend/);
		assert.deepEqual(mapGaps(topic([]), T0), ["the map has no components yet"]);
	});

	it("orders repairs, check-ups, confirmations, the frontier, then mapping", () => {
		const t = topic(
			[comp("target", ["mid", "wrong"]), comp("mid", ["base"]), comp("base"), comp("wrong"), comp("old"), comp("lesson"), comp("blocked", ["mid"]), comp("unknown")],
			[ev("target", "map", "missing", 1), ev("mid", "map", "missing", 1), ev("base", "map", "held", 1), ev("wrong", "map", "misconception", 1), ev("old", "map", "held", 0), ev("lesson", "lesson-complete", undefined, 1), ev("blocked", "map", "missing", 1)],
		);
		const items = whatNext(t, T0 + 8 * DAY);
		assert.deepEqual(items.map((i) => `${i.kind}:${i.componentId ?? ""}`), ["repair:wrong", "checkup:old", "checkup:base", "confirm:lesson", "learn:mid", "map:"]);
		assert.deepEqual(topicProgress(t, T0 + 2 * DAY), { held: 2, total: 8 });
	});
});

describe("topic store", () => {
	it("creates, edits, appends evidence and lists newest first", () => {
		const a = topicStore.createTopic({ id: "topic_store_a", title: " Transformers ", mapChatId: "chat_a" });
		assert.equal(a.title, "Transformers");
		topicStore.saveComponents(a.id, [comp("c_1")], "Implement attention from scratch");
		topicStore.appendEvidence(a.id, ev("c_1", "map", "held", 1));
		const back = topicStore.getTopic(a.id)!;
		assert.equal(back.goal, "Implement attention from scratch");
		assert.equal(back.evidence.length, 1);
		topicStore.createTopic({ id: "topic_store_b", title: "B", mapChatId: "chat_b" });
		assert.deepEqual(topicStore.listTopics().map((t) => t.id).sort(), ["topic_store_a", "topic_store_b"]);
		const later = topicStore.listTopics();
		assert(later[0]!.updatedAt >= later[1]!.updatedAt, "most recently updated first");
		assert.equal(topicStore.getTopic("../escape"), null, "ids outside topic_… never touch the filesystem");
		assert(topicStore.deleteTopic(a.id));
		assert.equal(topicStore.getTopic(a.id), null);
	});
});

function memoryStore(record: TopicRecord): TopicStore & { record: TopicRecord } {
	const store = {
		record,
		createTopic: () => { throw new Error("unused"); },
		getTopic: (id: string) => (id === store.record.id ? structuredClone(store.record) : null),
		listTopics: () => [structuredClone(store.record), { ...topic([comp("x")], [ev("x", "map", "held", 1)]), id: "topic_other", title: "Other" }],
		saveComponents: (_id: string, components: TopicComponent[], goal?: string) => { store.record = { ...store.record, components, ...(goal ? { goal } : {}) }; return store.record; },
		appendEvidence: (_id: string, e: TopicEvidence) => { store.record = { ...store.record, evidence: [...store.record.evidence, e] }; return store.record; },
		markMapped: (_id: string, at: string) => { store.record = { ...store.record, mappedAt: at }; return store.record; },
		deleteTopic: () => false,
		updateSource: () => store.record,
	};
	return store;
}
const run = async (tools: Record<string, { execute: (...a: any[]) => Promise<any> }>, name: string, input: unknown = {}) => {
	const result = await tools[name]!.execute("call", input, undefined);
	return { text: result.content[0].text as string, isError: result.isError === true };
};

describe("mapper tools", () => {
	it("mapping: grow the map, record verdicts, refuse map_done until held ground", async () => {
		const store = memoryStore(topic([]));
		const tools = topicTools({ chatId: "chat_map", link: { topicId: "topic_t", mode: "map" }, topicStore: store });
		assert.deepEqual(Object.keys(tools), ["topic_map", "map_components", "map_verdict", "map_done", "list_topics"]);
		assert.match((await run(tools, "topic_map")).text, /GOAL: \(not concrete yet/);
		const added = await run(tools, "map_components", { goal: "Implement attention", components: [{ key: "att", name: "Attention", description: "d" }, { key: "sm", name: "Softmax", description: "d" }], links: [{ component: "att", prerequisite: "sm" }] });
		assert(!added.isError, added.text);
		const [att, sm] = store.record.components.map((c) => c.id);
		assert.equal(store.record.goal, "Implement attention");
		assert((await run(tools, "map_verdict", { component: "c_nope", verdict: "held", note: "n" })).isError);
		assert.match((await run(tools, "map_verdict", { component: att, verdict: "missing", note: "no idea" })).text, /MISSING/);
		const refused = await run(tools, "map_done");
		assert(refused.isError); assert.match(refused.text, /Softmax .* is not probed yet/);
		await run(tools, "map_verdict", { component: sm, verdict: "held", note: "solid" });
		assert(!(await run(tools, "map_done")).isError);
		assert(store.record.mappedAt);
		assert.equal(store.record.evidence[0]!.kind, "map");
		assert.match((await run(tools, "list_topics")).text, /Other:\n- X: (held|due) \(map held\)/);
		assert((await run(tools, "map_components", { components: [], links: [{ component: sm, prerequisite: att }] })).isError, "cycle refused");
	});

	it("check-up: only topic_map + one component's verdict", async () => {
		const store = memoryStore(topic([comp("c_a"), comp("c_b")], [ev("c_a", "map", "held", 1)]));
		const tools = topicTools({ chatId: "chat_check", link: { topicId: "topic_t", mode: "checkup", componentId: "c_a" }, topicStore: store });
		assert.deepEqual(Object.keys(tools), ["topic_map", "map_verdict"]);
		assert.match((await run(tools, "topic_map")).text, /MODE: check-up of ONE component — C_A \(c_a\)/);
		assert((await run(tools, "map_verdict", { component: "c_b", verdict: "held", note: "n" })).isError);
		await run(tools, "map_verdict", { component: "c_a", verdict: "shaky", note: "forgot the scaling" });
		assert.equal(store.record.evidence.at(-1)!.kind, "checkup");
	});

	it("the mapper registry: prober mechanics + topic tools, never probe_done; its own doctrine composes", () => {
		const store = memoryStore(topic([]));
		const tools = createMapperTools({ chatId: "chat_map", link: { topicId: "topic_t", mode: "map" }, topicStore: store, chatStore: { getChat: () => null } as never, jobStore: {} as never, spawn: () => {} });
		for (const name of ["probe", "ask_user_question", "topic_map", "map_components", "map_verdict", "map_done", "research", "pdf"]) assert(name in tools, name);
		assert(!("probe_done" in tools));
		const prompt = composeInstructions("mapper");
		assert.match(prompt, /# The topic map/);
		assert.match(prompt, /Descend until held ground/);
		assert.match(renderTopicMap(topic([comp("c_a")]), { topicId: "topic_t", mode: "map" }), /OPEN \(map_done refuses until these close\):\n- C_A \(c_a\) is not probed yet/);
	});
});
