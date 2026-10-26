"use client";

/**
 * THE CONNECTION CONTROLS' CLIENT HALF (web host, 2026-10-25): the settings
 * UI's ChatGPT / Copilot / Grok controls over /api/connections/*. This
 * replaced the desktop preload bridge with the same method surface, so the
 * dialogs' state machines are unchanged.
 *
 * Change notifications arrive as `connections-changed` on the window's one
 * SSE channel; SidebarProvider (root lifetime) relays them — and every
 * channel reconnect — as the lh:connections-changed window event, which
 * onChange listens to (the settings-signal dialect).
 *
 * TEST SEAM: `connectionBridges` is a mutable registry; tests swap in fakes
 * and restore the HTTP defaults afterwards.
 */
import type { ChatGPTControlBridge, NativeSubscriptionControlBridge, NativeSubscriptionProviderId, NativeSubscriptionStatus } from "@/src/core";

export const CONNECTIONS_CHANGED_EVENT = "lh:connections-changed";

export function announceConnectionsChanged(): void {
	window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
}

function onChange(callback: () => void): () => void {
	const listener = () => callback();
	window.addEventListener(CONNECTIONS_CHANGED_EVENT, listener);
	return () => window.removeEventListener(CONNECTIONS_CHANGED_EVENT, listener);
}

async function call(path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(path, body === undefined
		? { cache: "no-store" }
		: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

const CHATGPT = "/api/connections/chatgpt";
const SUBSCRIPTIONS = "/api/connections/subscriptions";

/** Replies are status or {error}; the dialog validates and shows either. */
export const httpChatGPTBridge: ChatGPTControlBridge = {
	status: () => call(CHATGPT) as never,
	login: (id) => call(CHATGPT, { op: "login", id }) as never,
	complete: (callbackUrl) => call(CHATGPT, { op: "complete", callbackUrl }) as never,
	cancel: () => call(CHATGPT, { op: "cancel" }) as never,
	select: (id) => call(CHATGPT, { op: "select", id }) as never,
	disconnect: (id) => call(CHATGPT, { op: "disconnect", id }) as never,
	logout: (id) => call(CHATGPT, { op: "logout", id }) as never,
	consent: (enabled) => call(CHATGPT, { op: "consent", enabled }) as never,
	onChange,
};

/** Subscription controls throw the server's public error copy. */
async function control(body: Record<string, unknown>): Promise<unknown> {
	const value = await call(SUBSCRIPTIONS, body);
	if (value && typeof value === "object" && "error" in value && typeof value.error === "string") throw new Error(value.error);
	return value;
}
async function subscriptionStatuses(): Promise<NativeSubscriptionStatus[]> {
	const value = await call(SUBSCRIPTIONS);
	if (!Array.isArray(value)) throw new Error("Subscription status is unavailable.");
	return value as NativeSubscriptionStatus[];
}

/** Device-code sign-in outlives any request: start it, then settle when the
 * provider's status leaves pending — rejecting when it ended in an error,
 * resolving on success or cancellation (the desktop bridge's contract). */
async function login(providerId: NativeSubscriptionProviderId, enabled?: boolean): Promise<void> {
	await control({ op: "login", providerId, enabled });
	// The attempt is registered (status pending) before the start reply, so
	// only statuses read from here on can carry its outcome.
	return new Promise<void>((resolve, reject) => {
		let checking = false, again = false, done = false;
		const check = async () => {
			if (done) return;
			if (checking) { again = true; return; }
			checking = true;
			try {
				do {
					again = false;
					const status = (await subscriptionStatuses()).find((s) => s.providerId === providerId);
					if (status && !status.pending) {
						done = true; off();
						if (status.error) reject(new Error(status.error)); else resolve();
						return;
					}
				} while (again);
			} catch (error) { done = true; off(); reject(error); }
			finally { checking = false; }
		};
		const off = onChange(() => void check());
		void check();
	});
}

export const httpSubscriptionBridge: NativeSubscriptionControlBridge = {
	status: subscriptionStatuses,
	login,
	cancel: async (providerId) => { await control({ op: "cancel", providerId }); },
	respond: async (providerId, attemptId, promptId, value) => { await control({ op: "respond", providerId, attemptId, promptId, value }); },
	/** Opens the provider page in a new tab. The tab is created synchronously
	 * inside the click so popup blockers allow it, then pointed at the target. */
	open: async (providerId, attemptId, actionId) => {
		const tab = window.open("about:blank", "_blank");
		try {
			const value = await control({ op: "open", providerId, attemptId, actionId }) as { url?: unknown };
			if (typeof value.url !== "string" || !value.url.startsWith("https://")) throw new Error("The sign-in page is unavailable.");
			if (!tab) throw new Error("The browser blocked the new tab.");
			tab.opener = null;
			tab.location.href = value.url;
		} catch (error) { tab?.close(); throw error; }
	},
	retry: async (providerId) => { await control({ op: "retry", providerId }); },
	disconnect: async (providerId) => { await control({ op: "disconnect", providerId }); },
	consent: async (providerId, enabled) => { await control({ op: "consent", providerId, enabled }); },
	onChange,
};

export const connectionBridges: { chatgpt: ChatGPTControlBridge; subscriptions: NativeSubscriptionControlBridge } = {
	chatgpt: httpChatGPTBridge,
	subscriptions: httpSubscriptionBridge,
};
