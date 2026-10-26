/** Push notifications (web host, 2026-10-26): record, subscriptions, digest, limit alerts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { digestPayload, digestTick, limitPushPayload, PUSH_FILE, pushPublicKey, pushSettings, sendPush, setDigestTime, subscribePush, unsubscribePush, validSubscription, type PushSender } from "../src/server/push.ts";
import { deviceLabel, urlBase64ToUint8Array } from "../components/settings/notifications-section.tsx";
import { stores } from "../src/server/stores.ts";

const sub = (n: number) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

describe("push record", () => {
	it("generates VAPID keys once, owner-only, and manages devices and the digest time", () => {
		const key = pushPublicKey();
		assert.equal(pushPublicKey(), key, "stable across reads");
		assert.equal(fs.statSync(PUSH_FILE).mode & 0o777, 0o600);
		subscribePush(sub(1), "iPhone · Safari");
		subscribePush(sub(1), "iPhone · Safari");
		subscribePush(sub(2), "Linux · Chrome");
		assert.deepEqual(pushSettings().devices.map((d) => d.label), ["iPhone · Safari", "Linux · Chrome"]);
		assert.throws(() => subscribePush({ endpoint: "http://insecure.example", keys: { p256dh: "x", auth: "y" } }, "x"), /Invalid push subscription/);
		assert.equal(validSubscription({ endpoint: "https://x.example", keys: {} }), false);
		assert.throws(() => setDigestTime("25:00"), /HH:MM/);
		setDigestTime("07:30");
		assert.equal(pushSettings().digestTime, "07:30");
		unsubscribePush(sub(2).endpoint);
		assert.equal(pushSettings().devices.length, 1);
	});

	it("sends to every device and prunes the ones the push service says are gone", async () => {
		subscribePush(sub(3), "Android · Chrome");
		const seen: string[] = [];
		const sender: PushSender = async (s, payload) => {
			seen.push(`${s.endpoint}:${JSON.parse(payload).title}`);
			if (s.endpoint.endsWith("/3")) throw Object.assign(new Error("gone"), { statusCode: 410 });
			return 201;
		};
		const result = await sendPush({ title: "T", body: "B", url: "/", tag: "t" }, sender);
		assert.deepEqual(result, { sent: 1, pruned: 1 });
		assert.equal(seen.length, 2);
		assert(!pushSettings().devices.some((d) => d.endpoint.endsWith("/3")));
	});
});

describe("the daily digest", () => {
	it("summarizes What next across topics, nothing when nothing waits", () => {
		const base = { topicId: "topic_a", topicTitle: "Transformers", reason: "r" };
		assert.equal(digestPayload([{ ...base, kind: "map", label: "Continue mapping" }]), null);
		const one = digestPayload([{ ...base, kind: "repair", componentId: "c", label: "Repair: Softmax" }, { ...base, kind: "checkup", componentId: "d", label: "Check-up: Matmul" }, { ...base, kind: "learn", componentId: "e", label: "Learn: Attention" }])!;
		assert.equal(one.body, "1 repair · 1 check-up · 1 ready to learn. First: Repair: Softmax (Transformers).");
		assert.equal(one.url, "/topic/topic_a");
		const two = digestPayload([{ ...base, kind: "learn", componentId: "e", label: "Learn: A" }, { ...base, topicId: "topic_b", kind: "learn", componentId: "f", label: "Learn: B" }])!;
		assert.equal(two.url, "/");
	});

	it("runs once a day after the set time, only with devices and waiting items", async () => {
		setDigestTime("09:00");
		const sent: string[] = [];
		const sender: PushSender = async (_s, payload) => { sent.push(JSON.parse(payload).body); return 201; };
		const day = (h: number, m = 0, d = 1) => new Date(2026, 10, d, h, m);
		assert.equal(await digestTick(day(8, 59), sender), "not-yet");
		stores.topicStore.createTopic({ id: "topic_digest", title: "Digest topic", mapChatId: "chat_x" });
		stores.topicStore.saveComponents("topic_digest", [{ id: "c_1", name: "Softmax", description: "d", prerequisites: [], createdAt: "2026-10-01T00:00:00.000Z" }]);
		stores.topicStore.appendEvidence("topic_digest", { componentId: "c_1", kind: "map", verdict: "misconception", note: "wrong", chatId: "chat_x", at: "2026-10-02T00:00:00.000Z" });
		assert.equal(await digestTick(day(9, 1), sender), "sent");
		assert.match(sent[0]!, /1 repair/);
		assert.equal(await digestTick(day(14), sender), "done", "once per day");
		assert.equal(await digestTick(day(9, 5, 2), sender), "sent", "next day again");
	});
});

describe("limit alerts and client helpers", () => {
	it("words the limit and its lifting; decodes keys; labels devices", () => {
		assert.match(limitPushPayload("limited", Date.parse("2026-10-26T14:32:00Z")).body, /^Background work is paused until /);
		assert.equal(limitPushPayload("lifted").title, "ChatGPT usage reset");
		assert.deepEqual([...urlBase64ToUint8Array("AQID_w")], [1, 2, 3, 255]);
		assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
		assert.equal(deviceLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"), "Linux · Chrome");
	});
});
