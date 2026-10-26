import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { piModels } from "../src/agent/models.ts";
import { toLlmMessages } from "../src/core/native-messages.ts";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { NATIVE_SUBSCRIPTIONS } from "../src/core/contracts/subscriptions.ts";
import { fakeConnectionHost } from "./fake-connection-host.ts";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subscription-background-"));
process.env.LH_DATA_DIR = path.join(directory, "data"); process.env.LH_AUTH_FILE = path.join(directory, "auth.json"); fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { stores } = await import("../src/server/stores.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { deliverJobResult, registerLiveAgent, unregisterLiveAgent, setTurnRunner, settleSteers, steerLiveChat, automaticFollowUpAllowed } = await import("../src/server/jobs.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
let host: ReturnType<typeof fakeConnectionHost>;
let revision = 0;
function connection(providerId: string, background: boolean) {
	revision++;
	host.deliver({ channel: "lh:subscriptions", op: "changed", snapshot: {
		statuses: NATIVE_SUBSCRIPTIONS.map((p) => ({ providerId: p.providerId, available: true, connected: true, pending: false, allowBackgroundUse: p.providerId === providerId ? background : true, connectionId: `fixture-${p.providerId}`, epoch: 1, authorityRevision: 1, revision })),
		models: Object.fromEntries(NATIVE_SUBSCRIPTIONS.map((p) => [p.providerId, piModels().getModels(p.providerId)])),
	} });
}
before(() => {
	host = fakeConnectionHost("lh:subscriptions", () => { throw new Error("unexpected fixture request"); });
});
after(() => {
	host.disconnect();
	fs.rmSync(directory, { recursive: true, force: true });
});
for (const p of NATIVE_SUBSCRIPTIONS) for (const revokeAfterQueue of [false, true]) test(`${p.providerId}: foreground survives and automatic queue retains ownership with background ${revokeAfterQueue ? "revoked" : "off"}`, { timeout: 5000 }, async () => {
	connection(p.providerId, revokeAfterQueue);
	const chat = stores.chatStore.createChat("Fixture mixed queue"); const model = { ...piModels().getModels(p.providerId)[0]!, provider: p.logicalId };
	stores.chatStore.saveSettings(chat.id, { model: { provider: p.logicalId, id: model.id } });
	const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "fixture-job-call" }); const result = { brief: "Fixture helper result", sources: [] };
	stores.jobStore.updateJob(job.id, { status: "running", result }); const steer = buildSubagentSteer(job, result); const contexts: string[] = [];
	const agent = new Agent({ initialState: { model, messages: [{ id: "fixture-initial", role: "user", content: "Initial learner input", timestamp: 1 } as AgentMessage] }, convertToLlm: toLlmMessages, streamFn: () => {
		contexts.push(JSON.stringify(agent.state.messages)); const stream = new AssistantMessageEventStream();
		const output = { role: "assistant" as const, provider: p.logicalId, api: model.api, model: model.id, content: [{ type: "text" as const, text: "Foreground response" }], stopReason: "stop" as const, timestamp: 2, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: "stop", message: output }); stream.end(); return stream;
	} });
	let wakes = 0;
	setTurnRunner(async (chatId, input) => { wakes++; if (input.type === "steers") stores.chatStore.saveMessages(chatId, [...stores.chatStore.getChat(chatId)!.messages, ...input.steers]); return 200; });
	assert(beginTurn(chat.id)); registerLiveAgent(chat.id, agent); const delivered = deliverJobResult(steer);
	assert(steerLiveChat(chat.id, { id: "fixture-live-learner", role: "user", content: "Continue my learning", timestamp: 3 } as never));
	if (revokeAfterQueue) connection(p.providerId, false);
	assert(!automaticFollowUpAllowed(chat.id, agent)); await agent.continue();
	assert.equal(contexts.length, 1); assert(contexts[0]!.includes("Continue my learning")); assert(!contexts[0]!.includes(steer.id));
	const persisted = persistTurn(stores.chatStore, chat.id, 0, agent.state.messages, false);
	unregisterLiveAgent(chat.id); endTurn(chat.id); settleSteers(chat.id, persisted); await new Promise((resolve) => setImmediate(resolve));
	assert.equal(wakes, 0); assert.equal(stores.jobStore.getJob(job.id)!.status, "running");
	connection(p.providerId, true); await delivered; assert.equal(wakes, 1); assert.equal(stores.jobStore.getJob(job.id)!.status, "done");
});
