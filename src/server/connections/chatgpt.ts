// LearnHarness-owned public-client OAuth. Never import pi's bundled login.
// The server process alone owns these credentials; dependencies are
// injectable for scratch tests.
//
// PASTE-BACK SIGN-IN (web host, 2026-10-25): OpenAI accepts only an
// http://127.0.0.1:<port>/auth/callback redirect for this flow. The app is
// viewed from other devices (tunnel / tailnet), so that redirect lands on
// the VIEWER's loopback and fails to load. The learner pastes that address
// back; complete() verifies it against the pending attempt and exchanges
// the code with the identical redirect URI. No listener is opened here.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatGPTPlanUsage, ChatGPTStatus, ChatGPTUsageWindow } from "../../core/contracts/chatgpt.ts";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
export const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const CALLBACK_PATH = "/auth/callback";
const REVOCATION_WARNING = "Account disconnected locally. Remote revocation could not be confirmed.";
const random = () => crypto.randomBytes(32).toString("base64url");

type FailureCode = "cancelled" | "timeout" | "storage" | "identity" | "scope" | "disconnected" | "background" | "limited" | "catalog" | "expired" | "network" | "pending" | "callback" | "unavailable";
type Failure = Error & { code: FailureCode; oauthCode?: string };
const fail = (code: FailureCode): Failure => Object.assign(new Error(code), { code });
const MESSAGES: Record<FailureCode, string> = {
	cancelled: "ChatGPT sign-in cancelled.",
	timeout: "ChatGPT sign-in timed out. Try again.",
	storage: "ChatGPT credentials could not be read or saved. Check local file access, then reconnect before making requests.",
	identity: "ChatGPT sign-in could not be verified. Select the intended saved account and try again.",
	scope: "ChatGPT plan permission is missing. Reconnect and authorize ChatGPT plan use.",
	disconnected: "This ChatGPT connection is disconnected. Reconnect in Providers.",
	limited: "ChatGPT plan limit reached — background work is held until the usage window resets.",
	background: "ChatGPT background use is off in this app. Enable Allow background use for all ChatGPT accounts in Providers, or explicitly select an API-key model for that workload.",
	catalog: "The ChatGPT account model catalog is unavailable. Retry the connection; no API-key fallback was used.",
	expired: "The ChatGPT session expired. Reconnect in Providers.",
	network: "ChatGPT could not be reached. Check your connection and try again.",
	pending: "A ChatGPT sign-in is already pending.",
	callback: "That address does not belong to this sign-in. Paste the full address of the page ChatGPT sent you to (it starts with http://127.0.0.1).",
	unavailable: "ChatGPT sign-in is unavailable.",
};
export function publicError(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" && code in MESSAGES ? MESSAGES[code as FailureCode] : "ChatGPT sign-in failed. Try again; no API-key fallback was used.";
}

interface Tokens { accessToken?: string; refreshToken?: string; idToken: string; scopes: string[]; expiresAt: number }
interface Registration { id: string; clientId: string; issuer: string; subject: string; email?: string; background?: boolean; reconnectRequired?: true; tokens?: Tokens }
export interface ChatGPTState { version: 1; hostId: string; activeId: string | null; registrations: Registration[]; allowBackgroundUse?: boolean }
export interface ChatGPTStore { read(): Promise<ChatGPTState | null>; write(state: ChatGPTState): Promise<void> }
export interface Stamp { epoch: number; authorityRevision: number; revision: number }
export interface ChatGPTChange { kind: "state"; stamp: Stamp; status: ChatGPTStatus; invalidate: "none" | "background" | "all" }
export interface LeaseExpectation { expectedAccountId: string; expectedAuthorityRevision: number; selectedModelId: string }
interface TokenBody { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; token_type?: string; expires_in?: unknown; scope?: unknown }

const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !/[\x00-\x20\x7f]/.test(v);
const planScopes = (tokens: Tokens | undefined) => !!tokens?.accessToken && SCOPES.every((scope) => tokens.scopes.includes(scope));
/** Reject the entire credential record when its schema is invalid. */
export function validateState(state: unknown): ChatGPTState {
	const s = state as ChatGPTState;
	if (!s || s.version !== 1 || !nonempty(s.hostId) || !Array.isArray(s.registrations) || !(s.activeId === null || nonempty(s.activeId))) throw fail("storage");
	if (Object.hasOwn(s, "allowBackgroundUse") && typeof s.allowBackgroundUse !== "boolean") throw fail("storage");
	const ids = new Set<string>(); const clients = new Set<string>();
	for (const r of s.registrations) {
		if (!r || !nonempty(r.id) || ids.has(r.id) || !nonempty(r.clientId) || r.clientId === "dynamic_agent_client" || clients.has(r.clientId) || r.issuer !== ISSUER || !nonempty(r.subject) || (Object.hasOwn(r, "background") && typeof r.background !== "boolean") || (r.email !== undefined && typeof r.email !== "string") || (Object.hasOwn(r, "reconnectRequired") && r.reconnectRequired !== true)) throw fail("storage");
		ids.add(r.id); clients.add(r.clientId);
		if (r.tokens !== undefined) {
			const t = r.tokens;
			if (!t || !nonempty(t.idToken) || !Array.isArray(t.scopes) || t.scopes.some((x) => !nonempty(x)) || !Number.isFinite(t.expiresAt) || t.expiresAt < 0 || (t.accessToken !== undefined && (!nonempty(t.accessToken) || t.accessToken.startsWith("sk-"))) || (t.refreshToken !== undefined && !nonempty(t.refreshToken))) throw fail("storage");
		}
	}
	if (s.activeId !== null && !ids.has(s.activeId)) throw fail("storage");
	return s;
}

/** Private, unencrypted JSON outside learning data. No OS credential-store access. */
export function fileStore(file: string): ChatGPTStore {
	return {
		async read() {
			try {
				return validateState(JSON.parse(await fs.readFile(file, "utf8")));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw fail("storage");
			}
		},
		async write(state) {
			validateState(state);
			const temp = `${file}.${crypto.randomUUID()}.tmp`;
			let handle: fs.FileHandle | null = null;
			try {
				await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				handle = await fs.open(temp, "wx", 0o600);
				await handle.writeFile(`${JSON.stringify(state)}\n`);
				await handle.sync();
				await handle.close();
				handle = null;
				await fs.rename(temp, file);
				// Directory fsync is supported on Unix; the file fsync above is mandatory.
				if (process.platform !== "win32") {
					const dir = await fs.open(path.dirname(file), "r");
					try { await dir.sync(); } finally { await dir.close(); }
				}
			} catch {
				throw fail("storage");
			} finally {
				await handle?.close().catch(() => {});
				await fs.unlink(temp).catch(() => {});
			}
		},
	};
}

export function allowedAuthEndpoint(value: unknown): boolean {
	try {
		const url = new URL(value as string);
		return url.origin === ISSUER && !url.username && !url.password && !url.search && !url.hash;
	} catch { return false; }
}

/** ChatGPT's plan-usage endpoint — UNDOCUMENTED (the one behind Codex's
 * /status; owner decision 2026-10-26). Read with the app's own sign-in. */
export const PLAN_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTH_CLAIM = "https://api.openai.com/auth";

/** The ChatGPT workspace id Codex sends as ChatGPT-Account-ID, from the
 * stored (verified-at-sign-in) ID token's auth claim. */
export function chatGPTAccountId(idToken: string | undefined): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from((idToken ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
		const id = (payload[AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined)?.chatgpt_account_id;
		return typeof id === "string" && id ? id : undefined;
	} catch { return undefined; }
}

/** Parse the usage response defensively — the schema is not a contract. */
export function parsePlanUsage(body: unknown, now = new Date()): ChatGPTPlanUsage {
	const b = body as { plan_type?: unknown; rate_limit?: Record<string, unknown> } | null;
	const windows: ChatGPTUsageWindow[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const w = b?.rate_limit?.[key] as { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown; reset_after_seconds?: unknown } | null | undefined;
		if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) continue;
		const seconds = typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : undefined;
		const label = seconds === 18_000 ? "5h" : seconds === 604_800 ? "week" : seconds ? (seconds >= 86_400 ? `${Math.round(seconds / 86_400)}d` : `${Math.round(seconds / 3_600)}h`) : key === "primary_window" ? "5h" : "week";
		const resetsAt = typeof w.reset_at === "number" ? new Date(w.reset_at * 1000).toISOString()
			: typeof w.reset_after_seconds === "number" ? new Date(now.getTime() + w.reset_after_seconds * 1000).toISOString() : undefined;
		windows.push({ label, usedPercent: Math.max(0, Math.min(100, w.used_percent)), ...(resetsAt ? { resetsAt } : {}) });
	}
	if (!windows.length) return { available: false, reason: "ChatGPT returned no usage windows." };
	return { available: true, ...(typeof b?.plan_type === "string" ? { planType: b.plan_type } : {}), windows, fetchedAt: now.toISOString() };
}

/** A fresh loopback port per attempt (only the port may vary between sign-ins).
 * Nothing listens on it: the redirect is expected to fail on the viewer's device. */
const loopbackPort = () => 49152 + crypto.randomInt(16383);

/** A dynamically issued client whose first code exchange failed: reused, unbound. */
interface RetryRegistration { clientId: string; subject?: undefined; tokens?: undefined; email?: undefined }
interface Pending {
	abort: AbortController;
	cancel: (code?: FailureCode) => void;
	redirectUri: string;
	verifier: string;
	nonce: string;
	expectedState: string;
	selected?: Registration | RetryRegistration;
	attemptEpoch: number;
	url: string;
	consumed: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

export interface ChatGPTOptions {
	store: ChatGPTStore;
	fetch?: typeof globalThis.fetch;
	onChange?: (change: ChatGPTChange) => void;
	timeoutMs?: number;
}

export function createChatGPT({ store, fetch: request = globalThis.fetch, onChange = () => {}, timeoutMs = 180000 }: ChatGPTOptions) {
	let state: ChatGPTState | null = null;
	let init: Promise<void> | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	let epoch = 0;
	let revision = 0;
	let authorityRevision = 0;
	let catalogSequence = 0;
	let storageDenied = false;
	const stamp = (): Stamp => ({ epoch, authorityRevision, revision });
	let backgroundIntent: { enabled: boolean } | undefined;
	let pending: Pending | null = null;
	let catalog: { id: string; name: string }[] = [];
	let catalogError: string | null = null;
	let lastError: string | null = null;
	let closed = false;
	/** The plan limit was hit: background leases are held until then. */
	let limitedUntil: number | undefined;
	let limitTimer: ReturnType<typeof setTimeout> | undefined;
	let onLimitLift: (() => void) | undefined;
	let suspended = false;
	let retryRegistration: RetryRegistration | undefined;
	let transportAbort = new AbortController();
	let backgroundAbort = new AbortController();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn, fn);
		queue = next.catch(() => {});
		return next;
	};
	const current = (): ChatGPTState => { if (!state) throw fail("storage"); return state; };
	const active = () => !storageDenied && !suspended && !closed ? state?.registrations.find((r) => r.id === state!.activeId && r.tokens && !r.reconnectRequired) : undefined;
	// These fields are validated/verified before storage. Email is never identity.
	const sameAccount = (a: Registration, b: Registration) => a.issuer === b.issuer && a.subject === b.subject;
	function accountGroups() {
		const groups: Registration[][] = [];
		for (const record of state?.registrations || []) {
			const group = groups.find((members) => sameAccount(members[0]!, record));
			if (group) group.push(record); else groups.push([record]);
		}
		return groups;
	}
	const backgroundAllowed = () => state?.allowBackgroundUse !== false && backgroundIntent?.enabled !== false;
	const notify = (invalidate: ChatGPTChange["invalidate"] = "none") => { revision++; onChange({ kind: "state", stamp: stamp(), status: snapshot(), invalidate }); };
	function stop(backgroundOnly = false) {
		if (backgroundOnly) {
			backgroundAbort.abort();
			backgroundAbort = new AbortController();
			notify("background");
			return;
		}
		suspended = true;
		epoch++;
		authorityRevision++;
		catalogSequence++;
		transportAbort.abort();
		transportAbort = new AbortController();
		catalog = [];
		catalogError = null;
		notify("all");
	}
	async function ready() {
		if (closed) throw fail("disconnected");
		if (!init) init = (async () => {
			const loaded = await store.read();
			state = loaded ? validateState(loaded) : null;
			if (!state) {
				const first: ChatGPTState = { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, activeId: null, registrations: [] };
				await store.write(first);
				state = first;
			}
		})();
		try { await init; } catch (err) { denyStorage(err); throw err; }
	}
	function denyStorage(err: unknown) {
		if (!storageDenied) { storageDenied = true; lastError = publicError(err); stop(); }
	}
	async function save(next: ChatGPTState) {
		try { validateState(next); await store.write(next); } catch (err) {
			// A rotated token may already have invalidated its predecessor. Fail closed.
			denyStorage(err);
			lastError = publicError(err);
			notify();
			throw err;
		}
		state = next;
	}
	function snapshot(): ChatGPTStatus {
		return {
			available: !!state && !closed,
			pending: !!pending,
			...(pending && !pending.consumed ? { signInUrl: pending.url } : {}),
			allowBackgroundUse: backgroundAllowed(),
			...(limitedUntil !== undefined ? { limitedUntil: new Date(limitedUntil).toISOString() } : {}),
			activeId: state?.activeId ?? null,
			accounts: accountGroups().map((members) => {
				// Preserve the actual active registration ID at the private transport
				// boundary; inactive groups prefer a usable registration, then a
				// remembered one. No credential/client records are merged or deleted.
				const r = members.find((m) => m.id === state!.activeId) ?? members.find((m) => !m.reconnectRequired && planScopes(m.tokens)) ?? members[0]!;
				return {
					id: r.id,
					email: r.email || "ChatGPT account",
					registration: r.clientId,
					connected: !storageDenied && !closed && !suspended && !r.reconnectRequired && planScopes(r.tokens),
					planEnabled: !storageDenied && !r.reconnectRequired && planScopes(r.tokens),
					// Recovery is authorization-only, not a response to storage failure
					// or temporary transport suspension. Never infer it from error copy.
					canSignInAgain: !storageDenied && !closed && (r.reconnectRequired === true || !planScopes(r.tokens)),
				};
			}),
			error: lastError,
			catalogError,
		};
	}
	async function status(): Promise<ChatGPTStatus> {
		try { await ready(); } catch (err) { return { ...snapshot(), available: false, error: publicError(err) }; }
		return snapshot();
	}
	async function json<T = Record<string, unknown>>(url: string, options: RequestInit = {}): Promise<T> {
		try {
			const response = await request(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(15000) });
			if (!response.ok) {
				const body = await response.json().catch(() => ({})) as { error?: string | { code?: string } };
				const oauthCode = typeof body.error === "string" ? body.error : body.error?.code;
				throw Object.assign(fail(oauthCode === "invalid_grant" || response.status === 401 || response.status === 403 ? "expired" : "network"), { oauthCode });
			}
			return await response.json() as T;
		} catch (err) { throw (err as Failure).code ? err : fail("network"); }
	}
	async function identity(idToken: string, clientId: string, nonce: string | undefined, expectedSubject: string | undefined) {
		try {
			const { jwtVerify, createLocalJWKSet } = await import("jose");
			// Fixed, documented JWKS origin; never follow a discovery-supplied URL.
			const keys = await json<Parameters<typeof createLocalJWKSet>[0]>(JWKS);
			const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys), {
				issuer: ISSUER, audience: clientId, algorithms: ["RS256"],
				requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
			});
			if (typeof payload.sub !== "string" || !payload.sub || (nonce !== undefined && payload.nonce !== nonce) || (expectedSubject && payload.sub !== expectedSubject)) throw fail("identity");
			if ((payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw fail("identity");
			return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
		} catch { throw fail("identity"); }
	}
	function tokenSet(body: TokenBody, previous?: Tokens): Tokens {
		const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/) : previous?.scopes;
		if (!scopes || SCOPES.some((scope) => !scopes.includes(scope))) {
			// Lack of entitlement is not lack of revocable material.
			return { idToken: (body.id_token as string | undefined) ?? previous?.idToken ?? "", scopes: scopes ?? [], expiresAt: 0,
				...(nonempty(body.refresh_token) ? { refreshToken: body.refresh_token } : previous?.refreshToken ? { refreshToken: previous.refreshToken } : {}) };
		}
		if (typeof body.access_token !== "string" || !body.access_token || body.access_token.startsWith("sk-") || body.token_type?.toLowerCase() !== "bearer" || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw fail("identity");
		const refreshToken = (body.refresh_token as string | undefined) ?? previous?.refreshToken;
		if (!nonempty(refreshToken)) throw fail("identity");
		return { accessToken: body.access_token, refreshToken, idToken: (body.id_token as string | undefined) ?? previous?.idToken ?? "", scopes, expiresAt: Date.now() + body.expires_in * 1000 };
	}
	async function grant(fields: Record<string, string>, signal: AbortSignal) {
		return json<TokenBody>(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ ...fields, resource: RESOURCE }), signal });
	}

	/** Begin a paste-back sign-in. The returned status carries signInUrl. */
	async function login(accountId?: string): Promise<ChatGPTStatus> {
		await ready();
		if (pending) throw fail("pending");
		const s = current();
		const selected: Registration | RetryRegistration | undefined = accountId ? s.registrations.find((r) => r.id === accountId) : retryRegistration;
		if (accountId && !selected) throw fail("identity");
		const abort = new AbortController();
		const redirectUri = `http://127.0.0.1:${loopbackPort()}${CALLBACK_PATH}`;
		const attempt: Pending = {
			abort, redirectUri, selected, attemptEpoch: epoch, consumed: false,
			verifier: random(), nonce: random(), expectedState: random(), url: "",
			cancel: (code = "cancelled") => {
				abort.abort();
				clearTimeout(attempt.timer);
				if (pending === attempt) pending = null;
				lastError = publicError(fail(code));
				notify();
			},
		};
		const url = new URL(AUTHORIZE);
		url.search = new URLSearchParams({
			client_id: selected?.clientId ?? "dynamic_agent_client",
			...(selected ? {} : { agent_name_hint: "LearnHarness" }),
			ext_agent_host_id: s.hostId,
			...(selected?.tokens?.idToken ? { id_token_hint: selected.tokens.idToken } : {}),
			...(selected?.email ? { login_hint: selected.email } : {}),
			response_type: "code", redirect_uri: redirectUri, scope: SCOPES.join(" "), resource: RESOURCE,
			state: attempt.expectedState, nonce: attempt.nonce, code_challenge_method: "S256",
			code_challenge: crypto.createHash("sha256").update(attempt.verifier).digest("base64url"),
		}).toString();
		attempt.url = url.toString();
		attempt.timer = setTimeout(() => { if (!attempt.consumed) attempt.cancel("timeout"); }, timeoutMs);
		pending = attempt;
		lastError = null;
		notify();
		return snapshot();
	}

	/** Finish the pending sign-in from the pasted 127.0.0.1 callback address.
	 * A mismatched or malformed address is refused WITHOUT consuming the attempt. */
	async function complete(callbackUrl: unknown): Promise<ChatGPTStatus> {
		const attempt = pending;
		if (!attempt || attempt.consumed) throw fail("cancelled");
		let callback: URL;
		try { callback = new URL(typeof callbackUrl === "string" ? callbackUrl.trim() : ""); }
		catch { throw fail("callback"); }
		const expected = new URL(attempt.redirectUri);
		const params = callback.searchParams;
		// Reject duplicate parameters and unsolicited callbacks without consuming a valid pending attempt.
		if (callback.origin !== expected.origin || callback.pathname !== CALLBACK_PATH || callback.username || callback.password) throw fail("callback");
		if (["state", "code", "client_id", "error"].some((key) => params.getAll(key).length > 1) || params.get("state") !== attempt.expectedState) throw fail("callback");
		attempt.consumed = true;
		clearTimeout(attempt.timer);
		const { abort, selected, redirectUri } = attempt;
		try {
			if (params.has("error")) throw fail(params.get("error") === "access_denied" ? "cancelled" : "identity");
			const clientId = params.get("client_id") || selected?.clientId;
			if (!clientId || clientId === "dynamic_agent_client" || clientId.length > 512 || /[\s\x00-\x1f]/.test(clientId) || (selected && clientId !== selected.clientId) || !params.get("code")) throw fail("identity");
			let body: TokenBody;
			try { body = await grant({ grant_type: "authorization_code", client_id: clientId, code: params.get("code")!, code_verifier: attempt.verifier, redirect_uri: redirectUri }, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])); }
			catch (err) {
				if ((err as Failure).oauthCode === "invalid_grant" && !selected?.subject) retryRegistration = { clientId };
				throw err;
			}
			if (typeof body.id_token !== "string") throw fail("identity");
			const verified = await identity(body.id_token, clientId, attempt.nonce, selected?.subject);
			const tokens = tokenSet(body);
			await serial(async () => {
				if (closed || abort.signal.aborted || epoch !== attempt.attemptEpoch) throw fail("cancelled");
				const s = current();
				const existing = s.registrations.find((r) => r.clientId === clientId);
				if (existing && existing.subject !== verified.subject) throw fail("identity");
				const record: Registration = { id: existing?.id ?? crypto.randomUUID(), clientId, issuer: ISSUER, subject: verified.subject, ...(verified.email !== undefined ? { email: verified.email } : {}), tokens };
				const next = structuredClone(s);
				next.registrations = next.registrations.filter((r) => r.id !== record.id).concat(record);
				next.activeId = record.id;
				const previous = structuredClone(s);
				await save(next); // Active identity changes only AFTER validation and durable persistence.
				if (closed || abort.signal.aborted || epoch !== attempt.attemptEpoch) {
					await save(previous);
					throw fail("cancelled");
				}
				stop();
				storageDenied = false;
				suspended = false;
				retryRegistration = undefined;
			});
			lastError = planScopes(tokens) ? null : publicError(fail("scope"));
		} catch (err) { if (!abort.signal.aborted) lastError = publicError(err); }
		finally { if (pending === attempt) pending = null; notify(); }
		return snapshot();
	}
	function cancelLogin() { pending?.cancel(); return snapshot(); }

	function authorized(background: boolean, expected?: LeaseExpectation, capturedEpoch?: number) {
		const account = active();
		if (!account || (capturedEpoch !== undefined && capturedEpoch !== epoch)) throw fail("disconnected");
		if (!planScopes(account.tokens)) throw fail("scope");
		if (expected && (expected.expectedAccountId !== account.id || expected.expectedAuthorityRevision !== authorityRevision || !catalog.some((m) => m.id === expected.selectedModelId))) throw fail("catalog");
		if (background && !backgroundAllowed()) throw fail("background");
		if (background && limitedUntil !== undefined && Date.now() < limitedUntil) throw fail("limited");
		return account as Registration & { tokens: Tokens };
	}
	async function credential(background: boolean, expected?: LeaseExpectation) {
		await ready();
		return serial(async () => {
			const requestEpoch = epoch;
			const account = authorized(background, expected);
			if (account.tokens.expiresAt <= Date.now() + 60000) {
				const refreshEpoch = epoch;
				const signal = AbortSignal.any([transportAbort.signal, ...(background ? [backgroundAbort.signal] : []), AbortSignal.timeout(15000)]);
				let body: TokenBody;
				try { body = await grant({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.tokens.refreshToken! }, signal); }
				catch (err) {
					if ((err as Failure).oauthCode === "invalid_grant") {
						const next = structuredClone(current());
						delete next.registrations.find((r) => r.id === account.id)!.tokens;
						next.activeId = null;
						await save(next);
						stop();
						notify();
					}
					throw err;
				}
				let tokens: Tokens;
				try {
					if (body.id_token !== undefined) await identity(body.id_token as string, account.clientId, undefined, account.subject);
					tokens = tokenSet(body, account.tokens);
				} catch (err) {
					// The fixed token endpoint may have rotated already. Preserve only
					// verified identity and a single likely-latest revocation handle.
					stop();
					const restricted = structuredClone(current());
					const record = restricted.registrations.find((r) => r.id === account.id)!;
					record.reconnectRequired = true;
					if (nonempty(body.refresh_token)) record.tokens!.refreshToken = body.refresh_token;
					await save(restricted);
					lastError = publicError(fail("identity")); notify();
					throw err;
				}
				// A successful remote rotation must be durably retained even when
				// logout, account selection or consent revocation denies use.
				// Those serialized operations will revoke/clear the LATEST token.
				const next = structuredClone(current());
				next.registrations.find((r) => r.id === account.id)!.tokens = tokens;
				await save(next);
				if (closed || refreshEpoch !== epoch || signal.aborted) throw fail("disconnected");
			}
			const latest = authorized(background, expected, requestEpoch);
			return { accessToken: latest.tokens.accessToken!, accountId: latest.id, ...stamp() };
		});
	}
	async function lease(background: unknown, expected: Partial<LeaseExpectation> | undefined) {
		if (typeof background !== "boolean" || !expected || !nonempty(expected.expectedAccountId) || !Number.isSafeInteger(expected.expectedAuthorityRevision) || !nonempty(expected.selectedModelId)) throw fail("catalog");
		return credential(background, expected as LeaseExpectation);
	}
	/** Live plan usage for the active account (owner decision, 2026-10-26).
	 * Never throws: every refusal is { available: false, reason }. */
	async function planUsage(): Promise<ChatGPTPlanUsage> {
		try {
			await ready();
			if (!active()) return { available: false, reason: "No ChatGPT account is connected." };
			const token = await credential(false);
			const account = state?.registrations.find((r) => r.id === token.accountId);
			const accountId = chatGPTAccountId(account?.tokens?.idToken);
			const response = await request(PLAN_USAGE_URL, {
				redirect: "error",
				signal: AbortSignal.any([transportAbort.signal, AbortSignal.timeout(15000)]),
				headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json", ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}) },
			});
			if (!response.ok) {
				return { available: false, reason: response.status === 401 || response.status === 403 ? "ChatGPT does not share plan usage with this sign-in." : `ChatGPT usage could not be read (HTTP ${response.status}).` };
			}
			return parsePlanUsage(await response.json());
		} catch (err) {
			return { available: false, reason: (err as Failure).code ? publicError(err) : "ChatGPT usage could not be read." };
		}
	}
	const modelValue = () => ({ ...stamp(), status: snapshot(), accountId: active()?.id ?? null, models: catalog });
	async function models() {
		const sequence = ++catalogSequence;
		try {
			await ready();
			if (!active()) return modelValue();
			// Discovery is identity/scope authorization, not an invented model lease.
			const token = await credential(false);
			const body = await json<{ models?: unknown }>(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.any([transportAbort.signal, AbortSignal.timeout(15000)]) });
			authorized(false, undefined, token.epoch);
			if (sequence !== catalogSequence || active()?.id !== token.accountId || !Array.isArray(body.models)) throw fail("catalog");
			const visible = (body.models as { slug?: unknown; display_name?: unknown; visibility?: unknown }[])
				.filter((m) => m && m.visibility === "list" && nonempty(m.slug) && typeof m.display_name === "string")
				.map((m) => ({ id: m.slug as string, name: m.display_name as string }));
			const changed = JSON.stringify(visible) !== JSON.stringify(catalog);
			catalog = visible;
			if (changed) authorityRevision++;
			const hadError = catalogError !== null; catalogError = null;
			if (changed || hadError) notify();
			return modelValue();
		} catch {
			if (sequence === catalogSequence) {
				if (catalog.length) { catalog = []; authorityRevision++; }
				catalogError = publicError(fail("catalog")); notify();
			}
			return modelValue();
		}
	}
	async function select(id: string) {
		pending?.cancel();
		stop();
		const selectionIntent = epoch;
		await ready();
		return serial(async () => {
			const s = current();
			const account = s.registrations.find((r) => r.id === id);
			if (!account?.tokens) throw fail("disconnected");
			await save({ ...s, activeId: id });
			if (epoch !== selectionIntent || closed || storageDenied) throw fail("disconnected");
			suspended = false;
			lastError = null;
			notify();
			return snapshot();
		});
	}
	async function consent(enabled: unknown) {
		if (typeof enabled !== "boolean") throw fail("identity");
		// One app-owned intent, independent of account/registration lifetime.
		const intent = { enabled: false };
		backgroundIntent = intent; // ON cannot grant until its durable save.
		if (!enabled) stop(true); // Revoke all ChatGPT background streams only.
		await ready();
		return serial(async () => {
			await save({ ...structuredClone(current()), allowBackgroundUse: enabled });
			if (backgroundIntent === intent && enabled) backgroundIntent = undefined;
			notify();
			return snapshot();
		});
	}
	async function revoke(account: Registration) {
		let revoked = false;
		try {
			if (account.tokens?.refreshToken) {
				const config = await json<{ issuer?: unknown; revocation_endpoint?: unknown }>(`${ISSUER}/.well-known/openid-configuration`);
				if (config.issuer !== ISSUER || !allowedAuthEndpoint(config.revocation_endpoint)) throw fail("identity");
				for (let attempt = 0; attempt < 2; attempt++) {
					if (attempt) await new Promise((resolve) => setTimeout(resolve, 200));
					try {
						const response = await request(config.revocation_endpoint as string, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: account.tokens.refreshToken, token_type_hint: "refresh_token", client_id: account.clientId }) });
						revoked = response.status === 200;
						if (revoked || response.status < 500) break;
					} catch { /* retry only while the refresh token is still in memory */ }
				}
			}
		} catch { /* local action is mandatory even when revocation is unavailable */ }
		return revoked;
	}
	async function disconnect(id: string) {
		// Explicit local forgetting: a visible account represents every retained
		// registration with this exact verified issuer/subject, never its email.
		pending?.cancel();
		const initial = state?.registrations.find((r) => r.id === id);
		let stopped = !!initial && state!.registrations.some((r) => r.id === state!.activeId && sameAccount(r, initial));
		if (stopped) stop();
		await ready();
		return serial(async () => {
			const s = current();
			const target = s.registrations.find((r) => r.id === id);
			if (!target) throw fail("identity");
			const members = s.registrations.filter((r) => sameAccount(r, target));
			const activeGroup = members.some((r) => r.id === s.activeId);
			if (activeGroup && !stopped) { stop(); stopped = true; }
			const disconnectEpoch = epoch;
			let revoked = true;
			for (const member of members) { const confirmed = await revoke(member); revoked = confirmed && revoked; }
			const next = structuredClone(current());
			next.registrations = next.registrations.filter((r) => !sameAccount(r, target));
			if (activeGroup) next.activeId = null; // Never silently select another account.
			await save(next);
			if (members.some((r) => r.clientId === retryRegistration?.clientId)) retryRegistration = undefined;
			if (stopped && !closed && epoch === disconnectEpoch) suspended = false;
			lastError = revoked ? null : REVOCATION_WARNING;
			notify();
			return snapshot();
		});
	}
	async function logout(id: string) {
		pending?.cancel();
		stop();
		await ready();
		return serial(async () => {
			const account = current().registrations.find((r) => r.id === id);
			if (!account) throw fail("identity");
			const revoked = await revoke(account);
			const next = structuredClone(current());
			delete next.registrations.find((r) => r.id === id)!.tokens;
			if (next.activeId === id) next.activeId = null;
			const logoutEpoch = epoch;
			await save(next);
			if (!closed && epoch === logoutEpoch) suspended = false;
			lastError = revoked ? null : REVOCATION_WARNING;
			notify();
			return snapshot();
		});
	}
	/** Hold background work until `until` (ms). Re-checked at that time by
	 *  `recheck` (fresh usage) — still exhausted re-arms, otherwise the hold
	 *  lifts and every watcher resumes its deferred work. */
	function markLimited(until: number, recheck: () => Promise<number | undefined>, onLift?: () => void) {
		clearTimeout(limitTimer);
		limitedUntil = until;
		if (onLift) onLimitLift = onLift;
		stop(true); // background streams stop; foreground continues
		limitTimer = setTimeout(async () => {
			const next = await recheck().catch(() => undefined);
			if (next !== undefined && next > Date.now()) markLimited(next, recheck);
			else clearLimit();
		}, Math.max(1_000, until - Date.now()));
		(limitTimer as { unref?: () => void }).unref?.();
	}
	function clearLimit() {
		clearTimeout(limitTimer);
		if (limitedUntil === undefined) return;
		limitedUntil = undefined;
		notify();
		const lift = onLimitLift;
		onLimitLift = undefined;
		lift?.();
	}
	function close() { closed = true; clearTimeout(limitTimer); pending?.cancel(); stop(); }
	return { status, login, complete, cancelLogin, lease, models, planUsage, markLimited, clearLimit, select, consent, disconnect, logout, close, stamp };
}

export type ChatGPTService = ReturnType<typeof createChatGPT>;
