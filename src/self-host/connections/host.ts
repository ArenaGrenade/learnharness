/**
 * THE CONNECTION HOST (web host, 2026-10-25): the server process is the
 * sole owner of subscription credentials — what Electron main used to be.
 * One process-wide instance (globalThis: Next compiles each route as its
 * own module entry, see core/events.ts) creates the ChatGPT and native
 * subscription services, plugs them into the agent-layer bridges, and
 * relays every change to the event bus as `connections-changed`.
 *
 * The bridges see the same request/notification protocol the desktop IPC
 * carried: errors cross as public copy only, and notifications are
 * delivered asynchronously in emission order (queueMicrotask), so no
 * bridge listener ever runs inside a credential operation.
 */
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { emit } from "../../core/events.ts";
import type { ChatGPTPlanUsage, ChatGPTStatus } from "../../core/contracts/chatgpt.ts";
import type { NativeSubscriptionScope } from "../../core/contracts/subscriptions.ts";
import { acceptChatGPTChange, connectChatGPTHost } from "../../agent/chatgpt-bridge.ts";
import { acceptSubscriptionChange, connectSubscriptionHost } from "../../agent/subscription-bridge.ts";
import { createChatGPT, fileStore as chatGPTFileStore, publicError as chatGPTError, type ChatGPTService } from "./chatgpt.ts";
import { createSubscriptions, publicError as subscriptionError, type SubscriptionService } from "./subscriptions.ts";
import { PROVIDERS } from "./subscription-store.ts";
import { limitPushPayload, sendPush } from "../push.ts";

interface Host { chatgpt: ChatGPTService; subscriptions: SubscriptionService }
const KEY = Symbol.for("lh.connections.host");

const announce = () => emit("connections-changed", {});

function boot(): Host {
	const chatgpt = createChatGPT({
		store: chatGPTFileStore(path.join(PATHS.credentials, "chatgpt-credentials.json")),
		onChange: (change) => queueMicrotask(() => { acceptChatGPTChange(change); announce(); }),
	});
	const subscriptions = createSubscriptions({
		directory: PATHS.credentials,
		onChange: (snapshot) => queueMicrotask(() => { acceptSubscriptionChange(snapshot); announce(); }),
	});
	connectChatGPTHost({
		async request(op, fields) {
			try {
				if (op === "status") return { status: await chatgpt.status(), ...chatgpt.stamp() };
				if (op === "models") return await chatgpt.models();
				if (op === "lease" && typeof fields.background === "boolean") return await chatgpt.lease(fields.background, fields);
				if (op === "limit") { void holdForLimit(chatgpt); return { ok: true }; }
				throw new Error("Invalid private operation");
			} catch (err) { throw new Error(chatGPTError(err)); }
		},
	});
	connectSubscriptionHost({
		async request(op, fields) {
			try {
				if (op === "snapshot") return await subscriptions.snapshot();
				if (op === "lease" && typeof fields.background === "boolean" && validScope(fields.scope)) return await subscriptions.lease(fields.scope, fields.background);
				throw new Error("Invalid private operation");
			} catch (err) { throw new Error(subscriptionError(err)); }
		},
	});
	return { chatgpt, subscriptions };
}

/** Idempotent; the first call loads saved credentials and wires the bridges. */
export function connectionHost(): Host {
	const g = globalThis as typeof globalThis & { [KEY]?: Host };
	return (g[KEY] ??= boot());
}

function validScope(scope: unknown): scope is NativeSubscriptionScope {
	const s = scope as NativeSubscriptionScope;
	return !!s && PROVIDERS.includes(s.providerId) && typeof s.connectionId === "string" && !!s.connectionId && typeof s.selectedModelId === "string" && !!s.selectedModelId && [s.epoch, s.authorityRevision].every((n) => Number.isSafeInteger(n) && n >= 0);
}

/** POST /api/connections/chatgpt. Replies are client-safe status or {error}. */
export async function chatGPTControl(command: unknown, service: ChatGPTService = connectionHost().chatgpt): Promise<ChatGPTStatus | { error: string }> {
	const c = (command ?? {}) as { op?: unknown; id?: unknown; enabled?: unknown; callbackUrl?: unknown };
	try {
		if (c.op === "status") return await service.status();
		if (c.op === "login" && (c.id === undefined || typeof c.id === "string")) return await service.login(c.id);
		if (c.op === "complete" && typeof c.callbackUrl === "string" && c.callbackUrl.length <= 8192) return await service.complete(c.callbackUrl);
		if (c.op === "cancel") return service.cancelLogin();
		if (c.op === "select" && typeof c.id === "string") return await service.select(c.id);
		if (c.op === "disconnect" && typeof c.id === "string") return await service.disconnect(c.id);
		if (c.op === "logout" && typeof c.id === "string") return await service.logout(c.id);
		if (c.op === "consent" && typeof c.enabled === "boolean") return await service.consent(c.enabled);
		return { error: "Unsupported ChatGPT control." };
	} catch (err) { return { error: chatGPTError(err) }; }
}

/** POST /api/connections/subscriptions. Login only STARTS the device-code
 * flow: it outlives any HTTP request (tunnels cut idle requests), so its
 * progress and outcome arrive as status via `connections-changed`. */
export async function subscriptionControl(command: unknown, service: SubscriptionService = connectionHost().subscriptions): Promise<unknown> {
	const c = (command ?? {}) as { op?: unknown; providerId?: unknown; enabled?: unknown; attemptId?: unknown; promptId?: unknown; value?: unknown; actionId?: unknown };
	try {
		if (c.op === "status") return await service.status();
		if (!PROVIDERS.includes(c.providerId as never)) throw new Error();
		const id = c.providerId;
		switch (c.op) {
			case "login": {
				await service.ready;
				const started = service.login(id, c.enabled);
				// The outcome is published as status; a rejection is already projected there.
				started.catch(() => {});
				// Surface synchronous refusals (unavailable/interaction) to this request.
				await Promise.race([started, new Promise((resolve) => setImmediate(resolve))]);
				return { ok: true };
			}
			case "cancel": service.cancel(id); return { ok: true };
			case "respond": await service.respond(id, c.attemptId, c.promptId, c.value); return { ok: true };
			case "open": return await service.open(id, c.attemptId, c.actionId);
			case "retry": await service.retry(id); return { ok: true };
			case "disconnect": await service.disconnect(id); return { ok: true };
			case "consent": await service.consent(id, c.enabled); return { ok: true };
			default: throw new Error();
		}
	} catch (err) { return { error: subscriptionError(err) }; }
}

/** Plan usage is polled by every open view; ChatGPT throttles frequent
 *  reads, so one cached read serves everyone for USAGE_TTL_MS. The cache
 *  is keyed by the active account so a switch never shows the old one. */
const USAGE_TTL_MS = 120_000;
const USAGE_CACHE = Symbol.for("lh.connections.usage");
export async function chatGPTUsage(service: ChatGPTService = connectionHost().chatgpt, now = Date.now()): Promise<ChatGPTPlanUsage> {
	const g = globalThis as typeof globalThis & { [USAGE_CACHE]?: { key: string; at: number; value: Promise<ChatGPTPlanUsage> } };
	const key = (await service.status()).activeId ?? "";
	const cached = g[USAGE_CACHE];
	if (cached && cached.key === key && now - cached.at < USAGE_TTL_MS) return cached.value;
	const value = service.planUsage();
	g[USAGE_CACHE] = { key, at: now, value };
	return value;
}

/** When the exhausted window resets, from a FRESH usage read (bypassing the
 *  cache): the latest reset among windows at/near 100%. undefined when
 *  usage is unreadable or nothing is exhausted. */
async function exhaustedUntil(service: ChatGPTService): Promise<number | undefined> {
	(globalThis as typeof globalThis & { [USAGE_CACHE]?: unknown })[USAGE_CACHE] = undefined;
	const usage = await chatGPTUsage(service);
	if (!usage.available) return undefined;
	const resets = usage.windows.filter((w) => w.usedPercent >= 99 && w.resetsAt).map((w) => Date.parse(w.resetsAt!));
	return resets.length ? Math.max(...resets) : undefined;
}

/** Without a readable reset time, hold for this long, then let the next
 *  request find out (a fresh limit error re-arms the hold). */
const LIMIT_RECHECK_MS = 30 * 60_000;

/** A request hit the plan limit: hold background ChatGPT work until the
 *  window resets, then resume on its own (owner decision, 2026-10-26). */
export async function holdForLimit(service: ChatGPTService = connectionHost().chatgpt): Promise<void> {
	const wasLimited = !!(await service.status()).limitedUntil;
	const until = (await exhaustedUntil(service).catch(() => undefined)) ?? Date.now() + LIMIT_RECHECK_MS;
	service.markLimited(until, () => exhaustedUntil(service), () => void sendPush(limitPushPayload("lifted")).catch(() => {}));
	// Limit alerts (owner decision): once when the hold starts, once when it lifts.
	if (!wasLimited) void sendPush(limitPushPayload("limited", until)).catch(() => {});
}
