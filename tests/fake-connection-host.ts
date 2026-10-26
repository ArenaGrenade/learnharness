/**
 * Test double for the connection host (src/server/connections/host.ts):
 * installs a scripted host into the agent bridges and speaks the same
 * request/notification protocol the real host relays — requests surface
 * as messages `{channel, id, op, ...fields}`, and `deliver` feeds replies
 * (`{id, op, ok, value | error}`) and notifications back in. Not a test
 * file itself (the suite glob is tests/*.test.ts).
 */
import { acceptChatGPTChange, connectChatGPTHost, type ChatGPTStateChange } from "../src/agent/chatgpt-bridge.ts";
import { acceptSubscriptionChange, connectSubscriptionHost } from "../src/agent/subscription-bridge.ts";
import type { NativeSubscriptionSnapshot } from "../src/core/contracts/subscriptions.ts";

type Channel = "lh:chatgpt" | "lh:subscriptions";
export type HostMessage = Record<string, any> & { channel: Channel; id: string; op: string };
interface Call { op: string; resolve(value: unknown): void; reject(error: Error): void }

export function fakeConnectionHost(channel: Channel, onRequest: (message: HostMessage) => void) {
	const pending = new Map<string, Call>();
	let counter = 0;
	const request = (op: string, fields: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
		const id = `fake:${++counter}`;
		pending.set(id, { op, resolve, reject });
		try { onRequest({ ...fields, channel, id, op }); }
		catch (error) { pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
	});
	const disconnect = channel === "lh:chatgpt" ? connectChatGPTHost({ request }) : connectSubscriptionHost({ request });
	/** One host frame: a reply to a pending request and/or a notification. */
	function deliver(raw: unknown) {
		const message = raw as Record<string, any>;
		if (message?.channel !== channel) return;
		if (channel === "lh:chatgpt" && message.kind === "state") acceptChatGPTChange(message as ChatGPTStateChange);
		if (channel === "lh:subscriptions" && message.op === "changed" && message.snapshot) acceptSubscriptionChange(message.snapshot as NativeSubscriptionSnapshot);
		if (typeof message.id !== "string") return;
		const call = pending.get(message.id);
		if (!call || call.op !== message.op) return;
		pending.delete(message.id);
		if (message.ok === true) call.resolve(message.value);
		else call.reject(new Error(typeof message.error === "string" ? message.error : "Connection request failed."));
	}
	return { deliver, disconnect, pending };
}
