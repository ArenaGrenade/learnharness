/** The single-user lock (src/server/access.ts) and the proxy gate (proxy.ts). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-access-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
const { ACCESS_FILE, issueSession, loginThrottle, readAccess, sameOriginRequest, sessionValid, verifyPassphrase, writePassphrase, SESSION_COOKIE, SESSION_MAX_AGE_S } = await import("../src/server/access.ts");
const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const PASSPHRASE = "correct horse battery staple";
const request = (url: string, init: { method?: string; headers?: Record<string, string>; cookie?: string } = {}) =>
	new NextRequest(new URL(url, "https://lh.example.com"), { method: init.method ?? "GET", headers: { ...init.headers, ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}) } });

describe("no passphrase record: locked, never open", () => {
	it("refuses pages (redirect to /login) and API (401) while the login page stays reachable", () => {
		assert.equal(readAccess(), null);
		const page = proxy(request("/chat/new"));
		assert.equal(page.status, 307);
		assert.equal(new URL(page.headers.get("location")!).pathname, "/login");
		assert.equal(new URL(page.headers.get("location")!).searchParams.get("next"), "/chat/new");
		assert.equal(proxy(request("/api/chats")).status, 401);
		assert.equal(proxy(request("/login")).headers.get("x-middleware-next"), "1");
		assert.equal(sessionValid(null, "1".repeat(13) + "." + "a".repeat(43)), false);
	});
});

describe("passphrase record", () => {
	it("is owner-only, verifies only the right passphrase, and refuses an empty one", async () => {
		await assert.rejects(writePassphrase(""), /cannot be empty/);
		await writePassphrase("abc");
		assert.equal(await verifyPassphrase(readAccess()!, "abc"), true, "any non-empty passphrase is accepted");
		await writePassphrase(PASSPHRASE);
		assert.equal(fs.statSync(ACCESS_FILE).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.dirname(ACCESS_FILE)).mode & 0o077, 0);
		const record = readAccess()!;
		assert(record);
		assert(!fs.readFileSync(ACCESS_FILE, "utf8").includes(PASSPHRASE));
		assert.equal(await verifyPassphrase(record, PASSPHRASE), true);
		assert.equal(await verifyPassphrase(record, `${PASSPHRASE} `), false);
		assert.equal(await verifyPassphrase(record, ""), false);
	});

	it("a group/world-readable record locks instead of opening", async () => {
		await writePassphrase(PASSPHRASE);
		fs.chmodSync(ACCESS_FILE, 0o644);
		assert.equal(readAccess(), null);
		fs.chmodSync(ACCESS_FILE, 0o600);
		assert(readAccess());
	});

	it("sessions are signed, expire, and die when the passphrase changes", async () => {
		await writePassphrase(PASSPHRASE);
		const record = readAccess()!;
		const now = Date.now();
		const session = issueSession(record, now);
		assert.equal(sessionValid(record, session, now), true);
		assert.equal(sessionValid(record, session, now + SESSION_MAX_AGE_S * 1000 + 1), false, "expired");
		const [expiry, signature] = session.split(".");
		assert.equal(sessionValid(record, `${Number(expiry) + 1000}.${signature}`, now), false, "a moved expiry breaks the signature");
		assert.equal(sessionValid(record, `${expiry}.${"A".repeat(43)}`, now), false);
		assert.equal(sessionValid(record, undefined, now), false);
		const far = issueSession(record, now + 365 * 24 * 3600 * 1000);
		assert.equal(sessionValid(record, far, now), false, "a lifetime longer than the cookie's is refused");
		await writePassphrase("another long passphrase");
		assert.equal(sessionValid(readAccess(), session, now), false, "changing the passphrase signs every session out");
	});

	it("the proxy admits a valid session to pages and API, and nothing else", async () => {
		await writePassphrase(PASSPHRASE);
		const session = issueSession(readAccess()!);
		assert.equal(proxy(request("/", { cookie: session })).headers.get("x-middleware-next"), "1");
		assert.equal(proxy(request("/api/events", { cookie: session })).headers.get("x-middleware-next"), "1");
		assert.equal(proxy(request("/api/events", { cookie: "forged.value" })).status, 401);
		assert.equal(new URL(proxy(request("/")).headers.get("location")!).search, "", "home needs no next parameter");
	});
});

describe("cross-site requests", () => {
	it("refuses state changes from other sites even with a valid session, including the login POST", async () => {
		await writePassphrase(PASSPHRASE);
		const session = issueSession(readAccess()!);
		assert.equal(proxy(request("/api/settings", { method: "PUT", cookie: session, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
		assert.equal(proxy(request("/api/auth/login", { method: "POST", headers: { "sec-fetch-site": "same-site" } })).status, 403);
		assert.equal(proxy(request("/api/settings", { method: "PUT", cookie: session, headers: { "sec-fetch-site": "same-origin" } })).headers.get("x-middleware-next"), "1");
	});

	it("falls back to Origin vs the addressed host when Sec-Fetch-Site is absent", () => {
		const h = (headers: Record<string, string>) => new Headers(headers);
		assert.equal(sameOriginRequest("POST", h({ origin: "https://lh.example.com", host: "lh.example.com" })), true);
		assert.equal(sameOriginRequest("POST", h({ origin: "https://lh.example.com", host: "127.0.0.1:3000", "x-forwarded-host": "lh.example.com" })), true);
		assert.equal(sameOriginRequest("POST", h({ origin: "https://evil.example", host: "lh.example.com" })), false);
		assert.equal(sameOriginRequest("POST", h({ origin: "null", host: "lh.example.com" })), false);
		assert.equal(sameOriginRequest("POST", h({ host: "lh.example.com" })), true, "no browser page: forgery does not apply");
		assert.equal(sameOriginRequest("GET", h({ "sec-fetch-site": "cross-site" })), true, "reads are not state changes");
	});
});

describe("failed-login backoff", () => {
	it("five free failures, then doubling waits capped at 15 minutes; success resets", () => {
		const throttle = loginThrottle();
		throttle.succeed();
		const t = 1_000_000;
		for (let i = 0; i < 5; i++) { assert.equal(throttle.wait(t), 0); throttle.fail(t); }
		assert.equal(throttle.wait(t), 0);
		throttle.fail(t); assert.equal(throttle.wait(t), 30_000);
		throttle.fail(t); assert.equal(throttle.wait(t), 60_000);
		for (let i = 0; i < 10; i++) throttle.fail(t);
		assert.equal(throttle.wait(t), 15 * 60_000);
		throttle.succeed(); assert.equal(throttle.wait(t), 0);
	});
});
