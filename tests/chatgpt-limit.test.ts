/** ChatGPT plan-limit hold (web host, 2026-10-26): background held until reset, foreground untouched. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatGPT, SCOPES } from "../src/server/connections/chatgpt.ts";
import { holdForLimit } from "../src/server/connections/host.ts";
import { isChatGPTLimitError, chatGPTStreamError } from "../src/agent/chatgpt-stream.ts";
import { limitLine } from "../components/chatgpt-limit-banner.tsx";

function service(usage: () => unknown) {
	const state = { version: 1, hostId: "urn:uuid:host", activeId: "a", registrations: [{ id: "a", clientId: "oaiapp_a", issuer: "https://auth.openai.com", subject: "s", tokens: { accessToken: "access-a", refreshToken: "refresh-a", idToken: "h.e30.s", scopes: [...SCOPES], expiresAt: Date.now() + 3_600_000 } }] };
	return createChatGPT({
		store: { read: async () => structuredClone(state) as never, write: async () => {} },
		fetch: (async (url: string) => url.endsWith("/models")
			? Response.json({ models: [{ slug: "gpt-5", display_name: "GPT-5", visibility: "list" }] })
			: Response.json(usage())) as never,
	});
}
const expected = async (svc: ReturnType<typeof service>) => {
	const catalog = await svc.models();
	return { expectedAccountId: "a", expectedAuthorityRevision: catalog.authorityRevision, selectedModelId: "gpt-5" };
};

describe("the limit hold", () => {
	it("holds background leases until the reset, never foreground; lifts on its own", async () => {
		const svc = service(() => ({}));
		const exp = await expected(svc);
		let rechecks = 0;
		svc.markLimited(Date.now() + 80, async () => { rechecks++; return undefined; });
		assert.match((await svc.status()).limitedUntil ?? "", /^\d{4}-/);
		await assert.rejects(svc.lease(true, exp), /limited/);
		assert.equal((await svc.lease(false, exp)).accessToken, "access-a", "foreground still goes");
		await new Promise((r) => setTimeout(r, 1_200));
		assert.equal(rechecks, 1);
		assert.equal((await svc.status()).limitedUntil, undefined, "hold lifted after the recheck");
		assert.equal((await svc.lease(true, await expected(svc))).accessToken, "access-a");
		svc.close();
	});

	it("the host takes the reset time from a fresh usage read of the exhausted window", async () => {
		const reset = Math.floor(Date.now() / 1000) + 3600;
		const svc = service(() => ({ rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: reset }, secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: reset + 99999 } } }));
		await holdForLimit(svc);
		assert.equal((await svc.status()).limitedUntil, new Date(reset * 1000).toISOString());
		svc.close();
		const unreadable = service(() => ({ nope: true }));
		const before = Date.now();
		await holdForLimit(unreadable);
		const until = Date.parse((await unreadable.status()).limitedUntil!);
		assert(until >= before + 29 * 60_000 && until <= Date.now() + 30 * 60_000, "no readable reset → hold 30 minutes");
		unreadable.close();
	});
});

describe("limit detection and copy", () => {
	it("recognizes the documented code and the 429 it rides on, and explains the held state", () => {
		assert(isChatGPTLimitError("subscription_sharing_usage_limit_exceeded"));
		assert(isChatGPTLimitError("HTTP 429 Too Many Requests"));
		assert(!isChatGPTLimitError("HTTP 4290 nope"));
		assert.match(chatGPTStreamError("ChatGPT plan limit reached — background work is held"), /plan usage limit reached/);
		const now = Date.parse("2026-10-26T10:00:00Z");
		assert.match(limitLine("2026-10-26T14:32:00Z", now)!, /^ChatGPT plan limit reached — background work paused until /);
		assert.equal(limitLine("2026-10-26T09:00:00Z", now), null);
	});
});
