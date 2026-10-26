import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Api, Model, ModelAuth } from "@earendil-works/pi-ai";
import type { NativeSubscriptionProviderId, NativeSubscriptionScope, NativeSubscriptionSnapshot, NativeSubscriptionStatus, SubscriptionInteraction } from "../../core/contracts/subscriptions.ts";
import { PROVIDERS, fileStore, validateCredential, safeHttps, failure, type ConnectionState, type ConnectionStore, type OAuthCredential } from "./subscription-store.ts";

export const LABELS: Record<NativeSubscriptionProviderId, string> = { "github-copilot": "GitHub Copilot", xai: "Grok" };
const APIS = new Set(["openai-responses", "openai-completions", "anthropic-messages"]);
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
const MESSAGES: Record<string, string> = {
	storage: "The saved connection could not be read or written safely. Restart the server or reconnect after resolving the credential-file problem.",
	login: "Sign-in did not complete. Try connecting again.",
	refresh: "The connection could not be refreshed. Retry or reconnect in Providers.",
	cancel: "Sign-in cancelled.",
	unavailable: "This subscription connection is unavailable. Reconnect or explicitly choose another connection.",
	background: "Background use is off for this connection. Automatic follow-up remains deferred in its queue.",
	stale: "The connection or model catalog changed. Select an available model and retry.",
	interaction: "This sign-in action is no longer available.",
};
export function publicError(error: unknown): string { return MESSAGES[(error as { code?: string } | null)?.code ?? ""] ?? MESSAGES.unavailable!; }

/* The Pi SDK surface used here, typed loosely: its provider/Models generics
 * are wider than this collection needs, and every value crossing back is
 * re-validated (validateCredential / validEndpoint) before use. */
type SDK = { createModels(options?: any): any; githubCopilotProvider(): any; xaiProvider(): any };
/** The SAME SDK installation the server already runs, through public exports. */
export async function loadSubscriptionSDK(): Promise<SDK> {
	const [sdk, copilot, xai] = await Promise.all([import("@earendil-works/pi-ai"), import("@earendil-works/pi-ai/providers/github-copilot"), import("@earendil-works/pi-ai/providers/xai")]);
	return { ...sdk, ...copilot, ...xai } as unknown as SDK;
}
export function validEndpoint(providerId: string, auth: any, credential: OAuthCredential | undefined): boolean {
	if (!auth || (!(typeof auth.apiKey === "string" && auth.apiKey.length > 0) && !Object.entries(auth.headers ?? {}).some(([key, value]) => ["authorization", "x-api-key", "api-key"].includes(key.toLowerCase()) && typeof value === "string" && value.trim().length > 0))) return false;
	const value = auth.baseUrl ?? (providerId === "xai" ? "https://api.x.ai/v1" : "https://api.individual.githubcopilot.com");
	if (!safeHttps(value)) return false;
	const url = new URL(value);
	if (providerId === "xai") return url.origin === "https://api.x.ai" && url.pathname.replace(/\/$/, "") === "/v1" && !url.search && !url.hash;
	const domain = credential?.enterpriseUrl;
	return !url.search && !url.hash && url.pathname === "/" && (!url.port || url.port === "443") && (url.hostname.endsWith(".githubcopilot.com") || (!!domain && (url.hostname === domain || url.hostname.endsWith(`.${domain}`))));
}

interface Attempt { id: string; abort: AbortController; committing: boolean; actions: Map<string, string>; prompt: { id: string; resolve(value: string): void; reject(): void } | null; public: SubscriptionInteraction }
interface Entry {
	providerId: NativeSubscriptionProviderId; state: ConnectionState; disk: ConnectionStore;
	epoch: number; authorityRevision: number; revision: number; tail: Promise<unknown>; fatal: boolean; blocked: boolean; ready: boolean; error: string | undefined; authFailed: boolean;
	attempt: Attempt | null; catalog: Model<Api>[]; endpoint: string | null; provider?: any; models?: any;
}
export interface SubscriptionOptions {
	directory?: string;
	stores?: Partial<Record<NativeSubscriptionProviderId, ConnectionStore>>;
	sdk?: SDK;
	loadSDK?: () => Promise<SDK>;
	onChange?: (snapshot: NativeSubscriptionSnapshot) => void;
}

/** The server owns durable credentials and refresh. Everything returned by status/snapshot is explicitly projected. */
export function createSubscriptions(options: SubscriptionOptions) {
	let sdk: SDK;
	let closed = false;
	const entries = new Map<NativeSubscriptionProviderId, Entry>(PROVIDERS.map((providerId) => [providerId, {
		providerId, state: { version: 1, allowBackgroundUse: true }, disk: options.stores?.[providerId] ?? fileStore(path.join(options.directory!, `${providerId}-credentials.json`), providerId),
		epoch: 0, authorityRevision: 0, revision: 0, tail: Promise.resolve(), fatal: false, blocked: false, ready: false, error: undefined, authFailed: false, attempt: null, catalog: [], endpoint: null,
	}]));
	const entryFor = (id: unknown) => { const entry = entries.get(id as NativeSubscriptionProviderId); if (!entry) throw failure("unavailable"); return entry; };
	function serialized<T>(entry: Entry, fn: () => Promise<T>): Promise<T> { const result = entry.tail.then(fn); entry.tail = result.catch(() => {}); return result; }
	function statusOf(entry: Entry): NativeSubscriptionStatus {
		const available = entry.ready && !closed && !entry.fatal;
		const attempt = entry.attempt;
		return {
			providerId: entry.providerId, available, connected: !!(available && entry.state.credential && !entry.blocked && !entry.authFailed), pending: !!attempt, committing: attempt?.committing === true,
			allowBackgroundUse: entry.state.allowBackgroundUse, connectionId: entry.state.connectionId ?? null,
			epoch: entry.epoch, authorityRevision: entry.authorityRevision, revision: entry.revision,
			...(entry.error ? { error: entry.error } : {}),
			...(attempt ? { interaction: clone(attempt.public) } : {}),
		};
	}
	function snapshotNow(): NativeSubscriptionSnapshot {
		return { statuses: [...entries.values()].map(statusOf), models: Object.fromEntries([...entries.values()].map((entry) => [entry.providerId, statusOf(entry).connected ? clone(entry.catalog) : []])) };
	}
	function changed(entry: Entry) { entry.revision++; try { options.onChange?.(snapshotNow()); } catch { /* observer cannot break credential writes */ } }
	function catalog(entry: Entry) {
		let models: Model<Api>[] = entry.provider?.getModels().filter((model: Model<Api>) => APIS.has(model.api)) ?? [];
		if (!entry.state.credential) models = [];
		else if (entry.providerId === "github-copilot" && !Array.isArray(entry.state.credential.availableModelIds)) models = [];
		else if (entry.provider?.filterModels) models = [...entry.provider.filterModels(models, entry.state.credential)];
		if (JSON.stringify(models) !== JSON.stringify(entry.catalog)) { entry.catalog = models; entry.authorityRevision++; }
	}
	async function updateEndpoint(entry: Entry) {
		let endpoint: string | null = null;
		if (entry.state.credential) {
			const auth = await entry.provider.auth.oauth.toAuth(entry.state.credential);
			if (!validEndpoint(entry.providerId, auth, entry.state.credential)) throw failure("storage");
			endpoint = auth.baseUrl ?? (entry.providerId === "xai" ? "https://api.x.ai/v1" : "https://api.individual.githubcopilot.com");
		}
		if (entry.endpoint !== endpoint) { entry.endpoint = endpoint; entry.authorityRevision++; }
	}
	function storageFailed(entry: Entry) { entry.fatal = true; entry.blocked = true; entry.epoch++; entry.error = MESSAGES.storage; changed(entry); }
	async function save(entry: Entry, state: ConnectionState) {
		try { await entry.disk.write(state); } catch { storageFailed(entry); throw failure("storage"); }
		entry.state = clone(state);
		try { await updateEndpoint(entry); catalog(entry); } catch { storageFailed(entry); throw failure("storage"); }
		changed(entry);
	}
	const ready = (async () => {
		try { sdk = options.sdk ?? await (options.loadSDK ?? loadSubscriptionSDK)(); }
		catch { for (const entry of entries.values()) { entry.error = MESSAGES.unavailable; entry.fatal = true; changed(entry); } return; }
		await Promise.all([...entries.values()].map(async (entry) => {
			try {
				entry.state = clone(await entry.disk.read());
				const native = entry.providerId === "github-copilot" ? sdk.githubCopilotProvider() : sdk.xaiProvider();
				// No API-key auth method exists in this collection: ambient keys cannot become a fallback.
				entry.provider = { ...native, auth: { oauth: native.auth.oauth } };
				const store = {
					read: async (id: string) => id === entry.providerId ? clone(entry.state.credential) : undefined,
					list: async () => entry.state.credential ? [{ providerId: entry.providerId, type: "oauth" }] : [],
					modify: (id: string, fn: (value: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>, operation?: { signal?: AbortSignal }) => serialized(entry, async () => {
						if (id !== entry.providerId || entry.fatal || closed || operation?.signal?.aborted) throw failure("unavailable");
						const next = await fn(clone(entry.state.credential));
						// A returned rotation must be saved even if the connection closed while
						// refresh was in flight. Admission is rechecked after resolution;
						// queued logout deletes only after this serialized durable write.
						if (next !== undefined && JSON.stringify(next) !== JSON.stringify(entry.state.credential)) {
							try { validateCredential(id, next); } catch { storageFailed(entry); throw failure("storage"); }
							await save(entry, { ...entry.state, credential: next });
						}
						return clone(entry.state.credential);
					}),
					delete: (id: string) => serialized(entry, async () => {
						if (id !== entry.providerId || entry.fatal) throw failure("storage");
						await save(entry, { version: 1, allowBackgroundUse: entry.state.allowBackgroundUse });
					}),
				};
				entry.models = sdk.createModels({ credentials: store }); entry.models.setProvider(entry.provider);
				await updateEndpoint(entry); entry.ready = true; catalog(entry); changed(entry);
			} catch { entry.fatal = true; entry.error = MESSAGES.storage; changed(entry); }
		}));
	})();
	function current(entry: Entry, scope: NativeSubscriptionScope | undefined) {
		return statusOf(entry).connected && scope?.providerId === entry.providerId && scope.connectionId === entry.state.connectionId && scope.epoch === entry.epoch && scope.authorityRevision === entry.authorityRevision && entry.catalog.some((m) => m.id === scope.selectedModelId);
	}
	async function consent(providerId: unknown, enabled: unknown) {
		await ready; const entry = entryFor(providerId);
		if (typeof enabled !== "boolean" || entry.fatal || closed) throw failure("unavailable");
		await serialized(entry, async () => { if (entry.state.allowBackgroundUse !== enabled) await save(entry, { ...entry.state, allowBackgroundUse: enabled }); });
	}
	/** Runs the whole device-code login; resolves when it settles. Callers that
	 * only start it (the HTTP control) must not await it. */
	async function login(providerId: unknown, enabled?: unknown) {
		await ready; const entry = entryFor(providerId);
		if ((enabled !== undefined && typeof enabled !== "boolean") || entry.fatal || closed || !entry.ready) throw failure("unavailable");
		if ([...entries.values()].some((e) => e.attempt)) throw failure("interaction");
		const abort = new AbortController();
		const attempt: Attempt = { id: randomUUID(), abort, committing: false, actions: new Map(), prompt: null, public: { attemptId: "" } };
		attempt.public = { attemptId: attempt.id }; entry.attempt = attempt; entry.error = undefined; changed(entry);
		const active = () => entry.attempt === attempt && !abort.signal.aborted && !closed;
		const addBrowser = (value: string) => {
			if (!safeHttps(value)) throw failure("interaction");
			const id = randomUUID(); attempt.actions.set(id, value);
			const url = new URL(value); attempt.public.browser = { id, url: `${url.origin}${url.pathname}` };
		};
		try {
			const staging = sdk.createModels(); staging.setProvider(entry.provider);
			const credential = await staging.login(providerId, "oauth", {
				signal: abort.signal,
				notify: (event: { type: string; url?: string; verificationUri?: string; userCode?: string }) => {
					if (!active()) return;
					if (event.type === "auth_url") addBrowser(event.url!);
					if (event.type === "device_code") { addBrowser(event.verificationUri!); attempt.public.userCode = event.userCode; }
					// Native provider diagnostics are never forwarded. Public prompt wording comes from SDK-owned prompts.
					attempt.public.progress = event.type === "device_code" || event.type === "auth_url" ? "Complete sign-in in your browser." : "Waiting for the provider…";
					changed(entry);
				},
				prompt: (prompt: { type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[]; signal?: AbortSignal }) => new Promise<string>((resolve, reject) => {
					if (!active() || prompt.signal?.aborted) { reject(failure("cancel")); return; }
					const id = randomUUID();
					const stop = () => { cleanup(); reject(failure("cancel")); };
					const cleanup = () => { abort.signal.removeEventListener("abort", stop); prompt.signal?.removeEventListener("abort", stop); if (attempt.prompt?.id === id) { attempt.prompt = null; delete attempt.public.prompt; } };
					attempt.prompt = { id, resolve: (value) => { cleanup(); resolve(value); }, reject: stop };
					attempt.public.prompt = { id, type: prompt.type, message: prompt.message, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}), ...(prompt.type === "select" ? { options: clone(prompt.options) } : {}) };
					abort.signal.addEventListener("abort", stop, { once: true }); prompt.signal?.addEventListener("abort", stop, { once: true }); changed(entry);
				}),
			}, { agentName: "LearnHarness" });
			if (!active()) throw failure("cancel"); validateCredential(entry.providerId, credential);
			const auth = await entry.provider.auth.oauth.toAuth(credential);
			if (!validEndpoint(entry.providerId, auth, credential) || !active()) throw failure("login");
			await serialized(entry, async () => {
				if (!active() || entry.fatal) throw failure("cancel");
				attempt.committing = true; entry.blocked = true; entry.epoch++; changed(entry);
				await save(entry, { version: 1, allowBackgroundUse: (enabled as boolean | undefined) ?? entry.state.allowBackgroundUse, connectionId: randomUUID(), credential });
				entry.blocked = false; entry.authFailed = false; entry.error = undefined;
			});
		} catch (error) {
			if (active() && !entry.fatal) entry.error = (error as { code?: string })?.code === "cancel" ? undefined : MESSAGES.login;
			if (!abort.signal.aborted) throw failure(entry.fatal ? "storage" : "login");
		} finally { attempt.prompt?.reject(); if (entry.attempt === attempt) { entry.attempt = null; changed(entry); } }
	}
	function cancel(providerId: unknown) { const entry = entryFor(providerId); if (entry.attempt && !entry.attempt.committing) { entry.attempt.abort.abort(); entry.attempt = null; if (entry.authFailed && !entry.error) entry.error = MESSAGES.refresh; changed(entry); } }
	async function resolveAuth(entry: Entry, modelId: string): Promise<ModelAuth> {
		if (entry.fatal || closed || !entry.state.credential) throw failure("unavailable");
		const connectionId = entry.state.connectionId, epoch = entry.epoch;
		const unchanged = () => connectionId === entry.state.connectionId && epoch === entry.epoch && !entry.blocked && !closed;
		try {
			const model = entry.provider.getModels().find((m: Model<Api>) => m.id === modelId);
			if (!model) throw failure("stale");
			const resolved = await entry.models.getAuth(model);
			if (!unchanged()) throw failure("stale");
			if (!validEndpoint(entry.providerId, resolved?.auth, entry.state.credential)) throw failure("unavailable");
			return {
				...(typeof resolved.auth.apiKey === "string" ? { apiKey: resolved.auth.apiKey } : {}),
				...(resolved.auth.headers ? { headers: Object.fromEntries(Object.entries(resolved.auth.headers).filter(([, value]) => value === null || typeof value === "string")) } : {}),
				...(typeof resolved.auth.baseUrl === "string" ? { baseUrl: resolved.auth.baseUrl } : {}),
			} as ModelAuth;
		} catch (error) {
			if (!entry.fatal && unchanged()) { entry.authFailed = true; entry.error = MESSAGES.refresh; entry.epoch++; changed(entry); }
			throw failure(entry.fatal ? "storage" : (error as { code?: string })?.code === "stale" ? "stale" : "refresh");
		}
	}
	return {
		ready,
		async snapshot() { await ready; return snapshotNow(); },
		async status() { await ready; return snapshotNow().statuses; },
		login, consent, cancel,
		async respond(providerId: unknown, attemptId: unknown, promptId: unknown, value: unknown) {
			const entry = entryFor(providerId), attempt = entry.attempt, pendingPrompt = attempt?.prompt;
			if (!attempt || !pendingPrompt || attempt.id !== attemptId || pendingPrompt.id !== promptId || typeof value !== "string" || value.length > 4096) throw failure("interaction");
			const prompt = attempt.public.prompt!;
			if (prompt.type === "select" && !prompt.options?.some((option) => option.id === value)) throw failure("interaction");
			pendingPrompt.resolve(value); changed(entry);
		},
		/** The full https target of a sign-in action, for the viewer's browser to open. */
		async open(providerId: unknown, attemptId: unknown, actionId: unknown): Promise<{ url: string }> {
			const attempt = entryFor(providerId).attempt;
			const target = attempt && attempt.id === attemptId ? attempt.actions.get(actionId as string) : undefined;
			if (!target || !safeHttps(target)) throw failure("interaction");
			return { url: target };
		},
		async lease(scope: NativeSubscriptionScope, background: boolean) {
			await ready; const entry = entryFor(scope?.providerId);
			if (!current(entry, scope)) throw failure("stale");
			if (background && !entry.state.allowBackgroundUse) throw failure("background");
			const auth = await resolveAuth(entry, scope.selectedModelId);
			if (!current(entry, scope)) throw failure("stale");
			if (background && !entry.state.allowBackgroundUse) throw failure("background");
			return { scope: clone(scope), auth: clone(auth) };
		},
		async retry(providerId: unknown) {
			await ready; const entry = entryFor(providerId);
			const model = entry.catalog[0]; if (!model || entry.fatal || entry.blocked) throw failure("unavailable");
			await resolveAuth(entry, model.id); entry.authFailed = false; entry.error = undefined; changed(entry);
		},
		async disconnect(providerId: unknown) {
			await ready; const entry = entryFor(providerId); cancel(providerId);
			if (entry.fatal) throw failure("storage");
			entry.blocked = true; entry.epoch++; changed(entry);
			await entry.models.logout(providerId); entry.blocked = false; entry.authFailed = false; entry.error = undefined; changed(entry);
		},
		close() { closed = true; for (const entry of entries.values()) { cancel(entry.providerId); entry.epoch++; changed(entry); } },
	};
}

export type SubscriptionService = ReturnType<typeof createSubscriptions>;
