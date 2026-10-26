/**
 * THE SINGLE-USER LOCK (web host, 2026-10-25). The app is reached over a
 * tunnel or tailnet and can spend the owner's subscriptions and API keys,
 * so every page and API request needs a session — on top of whatever the
 * tunnel enforces (Cloudflare Access, tailnet membership).
 *
 * One record, data/credentials/access.json (0600): a scrypt hash of the
 * passphrase plus a random session-signing key. `npm run set-passphrase`
 * writes it; writing rotates the key, which signs out every session. No
 * record = locked: the proxy refuses everything until one exists.
 *
 * A session is a cookie `<expiry ms>.<HMAC-SHA256(key, expiry)>` — no
 * server-side session table; the key is the revocation handle.
 *
 * Read by proxy.ts (Node runtime) and the login route. Node builtins only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../config.ts";

export const ACCESS_FILE = path.join(PATHS.credentials, "access.json");
export const SESSION_COOKIE = "lh_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 } as const;
const scryptOptions = (params: { N: number; r: number; p: number }) => ({ ...params, maxmem: 128 * params.N * params.r * 2 });

export interface AccessRecord {
	version: 1;
	passphrase: { salt: string; hash: string; N: number; r: number; p: number };
	sessionKey: string;
}

function validRecord(value: unknown): value is AccessRecord {
	const r = value as AccessRecord;
	const b64 = (v: unknown, min: number) => typeof v === "string" && Buffer.from(v, "base64url").length >= min;
	return !!r && r.version === 1 && !!r.passphrase && b64(r.passphrase.salt, 16) && b64(r.passphrase.hash, SCRYPT.keylen)
		&& [r.passphrase.N, r.passphrase.r, r.passphrase.p].every((n) => Number.isSafeInteger(n) && n > 0) && b64(r.sessionKey, 32);
}

let cache: { stamp: string; record: AccessRecord | null } | undefined;
/** The current record, re-read when the file changes (a passphrase change
 * takes effect without a restart). Missing, unreadable, group/world-readable
 * or malformed → null: locked, never open. */
export function readAccess(file = ACCESS_FILE): AccessRecord | null {
	let stat: fs.Stats;
	try { stat = fs.statSync(file); } catch { cache = undefined; return null; }
	const stamp = `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}:${stat.mode}`;
	if (cache?.stamp === stamp) return cache.record;
	let record: AccessRecord | null = null;
	try {
		const ownerOnly = process.platform === "win32" || (stat.mode & 0o077) === 0;
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		record = ownerOnly && validRecord(parsed) ? parsed : null;
	} catch { record = null; }
	cache = { stamp, record };
	return record;
}

/** Hash a new passphrase and rotate the session key (signs every session out). */
export async function writePassphrase(passphrase: string, file = ACCESS_FILE): Promise<void> {
	if (!passphrase) throw new Error("The passphrase cannot be empty.");
	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(passphrase.normalize("NFC"), salt, SCRYPT.keylen, scryptOptions(SCRYPT));
	const record: AccessRecord = {
		version: 1,
		passphrase: { salt: salt.toString("base64url"), hash: hash.toString("base64url"), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
		sessionKey: crypto.randomBytes(32).toString("base64url"),
	};
	await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		const handle = await fsp.open(temp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`);
			await handle.sync();
		} finally { await handle.close(); }
		await fsp.rename(temp, file);
	} catch (err) { await fsp.unlink(temp).catch(() => {}); throw err; }
}

/** Constant-time check of a candidate passphrase against the record. */
export async function verifyPassphrase(record: AccessRecord, candidate: string): Promise<boolean> {
	const { salt, hash, N, r, p } = record.passphrase;
	const expected = Buffer.from(hash, "base64url");
	const actual = await new Promise<Buffer>((resolve, reject) => {
		crypto.scrypt(candidate.normalize("NFC"), Buffer.from(salt, "base64url"), expected.length, scryptOptions({ N, r, p }), (err, key) => err ? reject(err) : resolve(key));
	});
	return crypto.timingSafeEqual(actual, expected);
}

const sign = (record: AccessRecord, expiry: string) =>
	crypto.createHmac("sha256", Buffer.from(record.sessionKey, "base64url")).update(`lh-session:v1:${expiry}`).digest("base64url");

/** A fresh session cookie value, valid for SESSION_MAX_AGE_S. */
export function issueSession(record: AccessRecord, now = Date.now()): string {
	const expiry = String(now + SESSION_MAX_AGE_S * 1000);
	return `${expiry}.${sign(record, expiry)}`;
}

export function sessionValid(record: AccessRecord | null, value: string | undefined, now = Date.now()): boolean {
	if (!record || !value) return false;
	const match = /^(\d{13,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
	if (!match) return false;
	const expiry = Number(match[1]);
	if (!(expiry > now) || expiry > now + SESSION_MAX_AGE_S * 1000 + 60_000) return false;
	const expected = Buffer.from(sign(record, match[1]!));
	const actual = Buffer.from(match[2]!);
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Browser requests that change state must come from this app's own pages.
 * Sec-Fetch-Site is authoritative when present (every current browser sends
 * it and proxies cannot rewrite it into same-origin); otherwise Origin must
 * name the host the request was addressed to. Requests with neither are not
 * from a browser page, so cross-site forgery does not apply to them. */
export function sameOriginRequest(method: string, headers: Headers): boolean {
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
	const site = headers.get("sec-fetch-site");
	if (site) return site === "same-origin";
	const origin = headers.get("origin");
	if (!origin) return true;
	try {
		const host = new URL(origin).host;
		return host === headers.get("x-forwarded-host") || host === headers.get("host");
	} catch { return false; }
}

/** Failed-login backoff. One user, so one global counter: the first 5
 * failures are free, then each needs a doubling wait (30 s … 15 min).
 * Process memory only — a restart clears it. */
const THROTTLE = Symbol.for("lh.access.throttle");
export function loginThrottle() {
	const g = globalThis as typeof globalThis & { [THROTTLE]?: { failures: number; until: number } };
	const state = (g[THROTTLE] ??= { failures: 0, until: 0 });
	return {
		/** Milliseconds until the next attempt is allowed (0 = now). */
		wait: (now = Date.now()) => Math.max(0, state.until - now),
		fail(now = Date.now()) {
			state.failures++;
			if (state.failures > 5) state.until = now + Math.min(30_000 * 2 ** (state.failures - 6), 15 * 60_000);
		},
		succeed() { state.failures = 0; state.until = 0; },
	};
}
