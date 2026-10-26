/** Live ChatGPT plan usage (web host, 2026-10-26): parsing, the request, refusal, cache. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatGPTAccountId, createChatGPT, parsePlanUsage, PLAN_USAGE_URL, SCOPES } from "../src/server/connections/chatgpt.ts";
import { chatGPTUsage } from "../src/server/connections/host.ts";
import { usageTitle, usageTone } from "../components/chatgpt-usage-meter.tsx";

const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const NOW = new Date("2026-10-26T12:00:00.000Z");

describe("parsePlanUsage", () => {
	it("maps the 5-hour and weekly windows, clamps, and keeps the plan", () => {
		const usage = parsePlanUsage({ plan_type: "plus", rate_limit: {
			primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 1_793_016_000 },
			secondary_window: { used_percent: 140, limit_window_seconds: 604800, reset_after_seconds: 3600 },
		} }, NOW);
		assert(usage.available);
		assert.equal(usage.planType, "plus");
		assert.deepEqual(usage.windows, [
			{ label: "5h", usedPercent: 27, resetsAt: new Date(1_793_016_000_000).toISOString() },
			{ label: "week", usedPercent: 100, resetsAt: "2026-10-26T13:00:00.000Z" },
		]);
	});

	it("a weekly-only plan, odd windows, and garbage", () => {
		const weekly = parsePlanUsage({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } } }, NOW);
		assert(weekly.available); assert.equal(weekly.windows[0]!.label, "week");
		const odd = parsePlanUsage({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 7200 } } }, NOW);
		assert(odd.available); assert.equal(odd.windows[0]!.label, "2h");
		assert.deepEqual(parsePlanUsage({ nope: 1 }, NOW), { available: false, reason: "ChatGPT returned no usage windows." });
		assert.equal(parsePlanUsage(null, NOW).available, false);
	});
});

describe("chatGPTAccountId", () => {
	it("reads the auth claim of the stored ID token, tolerating anything else", () => {
		assert.equal(chatGPTAccountId(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })), "acct_123");
		assert.equal(chatGPTAccountId(jwt({ sub: "x" })), undefined);
		assert.equal(chatGPTAccountId("not-a-jwt"), undefined);
		assert.equal(chatGPTAccountId(undefined), undefined);
	});
});

function service(respond: (url: string, init: RequestInit) => Response) {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const state = { version: 1, hostId: "urn:uuid:host", activeId: "a", registrations: [{ id: "a", clientId: "oaiapp_a", issuer: "https://auth.openai.com", subject: "s", tokens: { accessToken: "access-a", refreshToken: "refresh-a", idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_a" } }), scopes: [...SCOPES], expiresAt: Date.now() + 3_600_000 } }] };
	const svc = createChatGPT({
		store: { read: async () => structuredClone(state) as never, write: async () => {} },
		fetch: (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return respond(url, init); }) as never,
	});
	return { svc, calls };
}

describe("planUsage", () => {
	it("calls the usage endpoint with the app's own token and the workspace id", async () => {
		const { svc, calls } = service(() => Response.json({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
		const usage = await svc.planUsage();
		assert(usage.available);
		assert.equal(calls[0]!.url, PLAN_USAGE_URL);
		assert.equal(calls[0]!.headers.Authorization, "Bearer access-a");
		assert.equal(calls[0]!.headers["ChatGPT-Account-ID"], "acct_a");
		svc.close();
	});

	it("a refusal is a normal outcome, never a throw", async () => {
		const { svc } = service(() => new Response("no", { status: 403 }));
		assert.deepEqual(await svc.planUsage(), { available: false, reason: "ChatGPT does not share plan usage with this sign-in." });
		svc.close();
		const down = service(() => { throw new Error("offline"); });
		assert.equal((await down.svc.planUsage()).available, false);
		down.svc.close();
	});

	it("the server cache serves repeat reads for two minutes", async () => {
		const { svc, calls } = service(() => Response.json({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
		const t = 10_000_000;
		await chatGPTUsage(svc, t); await chatGPTUsage(svc, t + 60_000);
		assert.equal(calls.length, 1);
		await chatGPTUsage(svc, t + 121_000);
		assert.equal(calls.length, 2);
		svc.close();
	});
});

describe("meter presentation", () => {
	it("tones by how close to the limit, and explains in the title", () => {
		assert.equal(usageTone(40), "text-muted-foreground");
		assert.equal(usageTone(85), "text-amber-300");
		assert.equal(usageTone(97), "text-red-400");
		assert.match(usageTitle([{ label: "5h", usedPercent: 34.4 }], "plus"), /^ChatGPT plus plan usage\n5h: 34% used\nOpen ChatGPT usage settings$/);
	});
});
