/** Learn from a paper (2026-10-26): arXiv parsing, outline checks, the trace flow, the outline marker. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArxivRef, newPaperOutlineMessage, applyMapComponents, nativeInputCause, type PaperOutline } from "../src/core/index.ts";
import { outlineProblems } from "../src/agent/subagents/paper-tracer.ts";
import { createTopic, getTopic, tracePaper } from "../src/server/topics.ts";
import { stores } from "../src/server/stores.ts";
import { projectView } from "../src/core/view.ts";

const outline = (): PaperOutline => ({
	title: "Attention Is All You Need",
	summary: "Replaces recurrence with attention.",
	concepts: [
		{ key: "softmax", name: "Softmax", description: "normalized exponentials", prerequisites: [], sources: [] },
		{ key: "attention", name: "Scaled dot-product attention", description: "weighted values", prerequisites: ["softmax"], sources: [{ title: "Neural Machine Translation by Jointly Learning to Align and Translate", url: "https://arxiv.org/abs/1409.0473" }] },
		{ key: "transformer", name: "The Transformer", description: "the paper's model", prerequisites: ["attention"], sources: [{ title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762" }] },
	],
	papers: [{ title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762", depth: 0 }, { title: "Bahdanau et al.", url: "https://arxiv.org/abs/1409.0473", depth: 1 }],
});

describe("parseArxivRef", () => {
	it("accepts ids and arXiv/alphaXiv links, rejects topics", () => {
		for (const input of ["1706.03762", "arXiv:1706.03762v5", "https://arxiv.org/abs/1706.03762", "arxiv.org/pdf/1706.03762v7.pdf", "https://www.alphaxiv.org/abs/1706.03762", "hep-th/9901001"]) {
			assert.ok(parseArxivRef(input), input);
		}
		assert.deepEqual(parseArxivRef(" https://arxiv.org/abs/2401.12345v2?context=cs "), { arxivId: "2401.12345v2", url: "https://arxiv.org/abs/2401.12345v2" });
		for (const input of ["Transformers", "real analysis 2401", "https://example.com/abs/1706.03762"]) assert.equal(parseArxivRef(input), null, input);
	});
});

describe("outline checks", () => {
	it("accepts a DAG with linked sources; refuses repeats, unknown keys, cycles, bare sources", () => {
		assert.equal(outlineProblems(outline()), null);
		const repeat = outline(); repeat.concepts[1]!.key = "softmax";
		assert.match(outlineProblems(repeat)!, /used twice/);
		const unknown = outline(); unknown.concepts[0]!.prerequisites = ["nope"];
		assert.match(outlineProblems(unknown)!, /unknown key "nope"/);
		const cycle = outline(); cycle.concepts[0]!.prerequisites = ["transformer"];
		assert.match(outlineProblems(cycle)!, /cycle/);
		const bare = outline(); bare.concepts[2]!.sources = [{ title: "x", url: "arxiv 1706" }];
		assert.match(outlineProblems(bare)!, /without an http/);
	});

	it("components keep sources from map_components (links only)", () => {
		const out = applyMapComponents([], { components: [{ key: "a", name: "A", description: "d", sources: [{ title: "Paper", url: "https://arxiv.org/abs/1" }, { title: "Bad", url: "javascript:alert(1)" }] }] }, () => "c_1", "2026-10-26T00:00:00.000Z");
		assert(out.ok);
		assert.deepEqual(out.components[0]!.sources, [{ title: "Paper", url: "https://arxiv.org/abs/1" }]);
	});
});

describe("the paper topic flow (scratch data, scripted tracer)", () => {
	it("an arXiv link starts a tracing topic; the outline lands on the topic and opens the mapping conversation", async () => {
		const created = createTopic("https://arxiv.org/abs/1706.03762");
		assert.equal(created.paper, true);
		assert.equal(created.topic.source?.status, "tracing");
		assert.equal(created.topic.source?.arxivId, "1706.03762");
		const steps: string[] = [];
		await tracePaper(created.topic.id, async (opts) => {
			assert.equal(opts.arxivId, "1706.03762");
			opts.onStep?.(1, "web_fetch_pdf", {} as never);
			steps.push(getTopic(created.topic.id)!.source!.progress!);
			return outline();
		});
		assert.deepEqual(steps, ["Step 1 · web_fetch_pdf"]);
		const topic = getTopic(created.topic.id)!;
		assert.equal(topic.source?.status, "ready");
		assert.equal(topic.title, "Attention Is All You Need");
		const chat = stores.chatStore.getChat(created.chatId)!;
		assert.equal((chat.messages[0] as { customType?: string }).customType, "paper-outline");
		assert.equal(chat.title, "Attention Is All You Need");
		assert.equal(projectView(chat.messages)[0]!.parts[0]!.type, "data-paper-outline");
	});

	it("a failed trace is an error on the topic, retryable", async () => {
		const created = createTopic("2401.00001");
		await tracePaper(created.topic.id, async () => { throw new Error("The tracer never submitted an outline."); });
		const topic = getTopic(created.topic.id)!;
		assert.equal(topic.source?.status, "error");
		assert.match(topic.source!.error!, /never submitted/);
		assert.equal(createTopic("Transformers").paper, false);
	});
});

describe("the outline marker", () => {
	it("is bracket-marked context listing concepts, prerequisites and sources; neutral input", () => {
		const marker = newPaperOutlineMessage(outline());
		assert.match(marker.content, /^\[Session context\] — this topic is a research paper/);
		assert.match(marker.content, /- \[attention\] Scaled dot-product attention: weighted values — rests on: Softmax — sources: Neural Machine Translation/);
		assert.equal(nativeInputCause(marker as never, []), "neutral");
	});
});
