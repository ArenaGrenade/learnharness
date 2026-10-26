import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NativeSubscriptionProviderId } from "../../core/contracts/subscriptions.ts";

export const PROVIDERS: readonly NativeSubscriptionProviderId[] = ["github-copilot", "xai"];
export type FailureCode = "storage" | "login" | "refresh" | "cancel" | "unavailable" | "background" | "stale" | "interaction";
export const failure = (code: FailureCode) => Object.assign(new Error(code), { code });

export interface OAuthCredential { type: "oauth"; access: string; refresh: string; expires: number; enterpriseUrl?: string; availableModelIds?: string[]; [key: string]: unknown }
export interface ConnectionState { version: 1; allowBackgroundUse: boolean; connectionId?: string; credential?: OAuthCredential }
export interface ConnectionStore { read(): Promise<ConnectionState>; write(state: ConnectionState): Promise<void> }

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\x00-\x20\x7f]/.test(value);
export function validateCredential(providerId: string, credential: unknown): OAuthCredential {
	const c = credential as OAuthCredential;
	if (!c || c.type !== "oauth" || !nonempty(c.access) || !nonempty(c.refresh) || !Number.isFinite(c.expires) || c.expires < 0) throw failure("storage");
	if (providerId === "github-copilot") {
		if (c.enterpriseUrl !== undefined && !safeDomain(c.enterpriseUrl)) throw failure("storage");
		if (c.availableModelIds !== undefined && (!Array.isArray(c.availableModelIds) || !c.availableModelIds.every(nonempty))) throw failure("storage");
	}
	return c;
}
export function safeDomain(value: unknown): boolean {
	if (typeof value !== "string" || !value || /[\s/:@?#\\]/.test(value)) return false;
	try { return new URL(`https://${value}`).hostname === value; } catch { return false; }
}
export function safeHttps(value: unknown): boolean {
	try {
		const url = new URL(value as string);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch { return false; }
}
export function validateState(providerId: string, state: unknown): ConnectionState {
	const s = state as ConnectionState;
	if (!PROVIDERS.includes(providerId as NativeSubscriptionProviderId) || !s || s.version !== 1 || typeof s.allowBackgroundUse !== "boolean") throw failure("storage");
	const hasId = Object.hasOwn(s, "connectionId");
	if (hasId !== Object.hasOwn(s, "credential") || (hasId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.connectionId!))) throw failure("storage");
	if (hasId) validateCredential(providerId, s.credential);
	return s;
}
/** Server-process-only, one independent owner-only file per provider. No recovery writes on corruption. */
export function fileStore(file: string, providerId: NativeSubscriptionProviderId, io: typeof fs = fs): ConnectionStore {
	return {
		async read() {
			try {
				const stat = await io.lstat(file);
				if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) throw failure("storage");
				return validateState(providerId, JSON.parse(await io.readFile(file, "utf8")));
			}
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, allowBackgroundUse: true }; throw failure("storage"); }
		},
		async write(state) {
			validateState(providerId, state);
			const temporary = `${file}.${randomUUID()}.tmp`;
			let handle: fs.FileHandle | null = null;
			try {
				await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				handle = await io.open(temporary, "wx", 0o600);
				await handle.writeFile(`${JSON.stringify(state)}\n`);
				await handle.sync(); await handle.close(); handle = null;
				await io.rename(temporary, file);
				if (process.platform !== "win32") {
					const directory = await io.open(path.dirname(file), "r");
					try { await directory.sync(); } finally { await directory.close(); }
				}
			} catch { throw failure("storage"); }
			finally { await handle?.close().catch(() => {}); await io.unlink(temporary).catch(() => {}); }
		},
	};
}
