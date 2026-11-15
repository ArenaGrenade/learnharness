import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { danglingQuestionOf, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { findPendingToolCall } from "../src/core/pending.ts";
import { projectView } from "../src/core/view.ts";
import { inputAppends } from "../src/core/input-events.ts";

function record(tool: string, input: unknown): LhMessage[] {
	return [{
		id: "interrupted", role: "assistant", stopReason: "aborted", timestamp: 1,
		content: [{ type: "toolCall", id: "question", name: tool, arguments: input }],
	} as unknown as LhMessage];
}

describe("interrupted question recovery", () => {
	for (const tool of ["quiz", "probe", "explain", "recall", "ask_user_question"]) {
		it(`${tool}: a partial saved call releases both pending gates and permits continuation`, () => {
			const messages = record(tool, {});
			assert.equal(danglingQuestionOf(messages), null);
			assert.equal(findPendingToolCall(projectView(messages)), null);
			assert.equal(projectView(messages)[0]!.parts[1]!.state, "output-error");
			const appends = inputAppends({ messages }, { type: "text", text: "continue" });
			const wire = toLlmMessages([...messages, ...appends]);
			assert.deepEqual(wire.map((m) => m.role), ["assistant", "toolResult", "user"]);
			assert.equal((wire[1] as { toolCallId?: string }).toolCallId, "question");
			assert.deepEqual(messages[0]!.content, [{ type: "toolCall", id: "question", name: tool, arguments: {} }], "raw history is preserved");
		});
	}

	it("keeps a partial streaming call in the writing state until it settles", () => {
		const view = projectView(record("quiz", {}), {
			executions: new Map(), inFlight: true, streamingIds: new Set(["interrupted"]),
		});
		assert.equal(view[0]!.parts[1]!.state, "input-streaming");
		assert.equal(findPendingToolCall(view), null);
	});

	it("a complete question stays answerable after reload, including a late Stop", () => {
		const inputs = {
			quiz: { question: "Which?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A is correct." },
			probe: { question: "Which?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A is correct." },
			explain: { question: "Why?", correctAnswer: "Because of the invariant." },
			recall: { question: "Why?", correctAnswer: "Because of the invariant." },
			ask_user_question: { question: "What next?" },
		};
		for (const [tool, input] of Object.entries(inputs)) {
			const messages = record(tool, input);
			assert.equal(danglingQuestionOf(messages)?.toolCallId, "question", tool);
			assert.equal(findPendingToolCall(projectView(messages))?.toolCallId, "question", tool);
		}
	});
});
