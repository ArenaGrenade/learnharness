/**
 * PUSH NOTIFICATIONS (web host, 2026-10-26 — owner design): Web Push to the
 * installed app on the owner's devices. Two kinds, by owner decision:
 *
 *  - the DAILY DIGEST at a set time (default 09:00 server time), only when
 *    something is waiting on What next across all topics;
 *  - LIMIT ALERTS: the ChatGPT plan limit was hit, and when it lifted.
 *
 * One owner-only record, data/credentials/push.json: the VAPID key pair
 * (generated on first use), the device subscriptions, the digest time and
 * the last digest date. Gone subscriptions (404/410) are pruned on send.
 * Messages leave the server for the browser vendor's push service (Apple,
 * Google, Mozilla) — outbound only; nothing inbound is needed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { PATHS } from "../../config.ts";
import { whatNext, type NextItem } from "../core/topic.ts";
import { stores } from "./stores.ts";

export const PUSH_FILE = path.join(PATHS.credentials, "push.json");
const VAPID_SUBJECT = "https://github.com/ArenaGrenade/learnharness";
export const DEFAULT_DIGEST_TIME = "09:00";

export interface PushSubscriptionRecord {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	/** The device as the browser described itself (for the settings list). */
	label: string;
	createdAt: string;
}
interface PushRecord {
	version: 1;
	vapid: { publicKey: string; privateKey: string };
	subscriptions: PushSubscriptionRecord[];
	digestTime: string;
	/** YYYY-MM-DD (server local) of the last digest run. */
	lastDigest?: string;
}
export interface PushPayload {
	title: string;
	body: string;
	/** Where a tap opens. */
	url: string;
	/** Same tag replaces an earlier notification instead of stacking. */
	tag: string;
}

function read(file = PUSH_FILE): PushRecord {
	try {
		const record = JSON.parse(fs.readFileSync(file, "utf8")) as PushRecord;
		if (record.version === 1 && record.vapid?.publicKey && record.vapid.privateKey && Array.isArray(record.subscriptions)) return record;
	} catch { /* first use: generate below */ }
	const keys = webpush.generateVAPIDKeys();
	const fresh: PushRecord = { version: 1, vapid: { publicKey: keys.publicKey, privateKey: keys.privateKey }, subscriptions: [], digestTime: DEFAULT_DIGEST_TIME };
	write(fresh, file);
	return fresh;
}

function write(record: PushRecord, file = PUSH_FILE): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
}

export function pushPublicKey(): string {
	return read().vapid.publicKey;
}

export function pushSettings(): { digestTime: string; devices: Array<{ endpoint: string; label: string; createdAt: string }> } {
	const record = read();
	return { digestTime: record.digestTime, devices: record.subscriptions.map(({ endpoint, label, createdAt }) => ({ endpoint, label, createdAt })) };
}

export class PushRequestError extends Error {}

/** Only real push-service endpoints (https) with the standard key pair. */
export function validSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
	const s = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
	if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 2048) return false;
	try { if (new URL(s.endpoint).protocol !== "https:") return false; } catch { return false; }
	return typeof s.keys?.p256dh === "string" && typeof s.keys.auth === "string" && s.keys.p256dh.length < 512 && s.keys.auth.length < 512;
}

export function subscribePush(subscription: unknown, label: string): void {
	if (!validSubscription(subscription)) throw new PushRequestError("Invalid push subscription.");
	const record = read();
	const rest = record.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
	write({ ...record, subscriptions: [...rest, { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, label: label.slice(0, 120) || "Device", createdAt: new Date().toISOString() }] });
}

export function unsubscribePush(endpoint: string): void {
	const record = read();
	write({ ...record, subscriptions: record.subscriptions.filter((s) => s.endpoint !== endpoint) });
}

export function setDigestTime(value: unknown): void {
	if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new PushRequestError("The digest time must be HH:MM (24-hour).");
	write({ ...read(), digestTime: value });
}

/** The sender seam (tests inject a fake). Returns the HTTP status. */
export type PushSender = (subscription: PushSubscriptionRecord, payload: string, vapid: PushRecord["vapid"]) => Promise<number>;
const webPushSender: PushSender = async (subscription, payload, vapid) => {
	const result = await webpush.sendNotification(subscription, payload, { vapidDetails: { subject: VAPID_SUBJECT, ...vapid }, TTL: 12 * 60 * 60, urgency: "normal" });
	return result.statusCode;
};

/** Send to every device; prune subscriptions the push service says are gone. */
export async function sendPush(payload: PushPayload, sender: PushSender = webPushSender): Promise<{ sent: number; pruned: number }> {
	const record = read();
	const gone: string[] = [];
	let sent = 0;
	await Promise.all(record.subscriptions.map(async (subscription) => {
		try { await sender(subscription, JSON.stringify(payload), record.vapid); sent++; }
		catch (err) {
			const status = (err as { statusCode?: number }).statusCode;
			if (status === 404 || status === 410) gone.push(subscription.endpoint);
			else console.error("[push] send failed:", status ?? (err instanceof Error ? err.message : err));
		}
	}));
	if (gone.length) write({ ...read(), subscriptions: read().subscriptions.filter((s) => !gone.includes(s.endpoint)) });
	return { sent, pruned: gone.length };
}

// ─── the daily digest ───────────────────────────────────────────────────────

/** The digest text from What next across every topic; null when nothing waits. */
export function digestPayload(items: ReadonlyArray<NextItem & { topicTitle: string }>): PushPayload | null {
	const actionable = items.filter((i) => i.kind !== "map");
	if (!actionable.length) return null;
	const count = (kind: NextItem["kind"]) => actionable.filter((i) => i.kind === kind).length;
	const parts = [
		count("repair") && `${count("repair")} repair${count("repair") > 1 ? "s" : ""}`,
		(count("checkup") + count("confirm")) && `${count("checkup") + count("confirm")} check-up${count("checkup") + count("confirm") > 1 ? "s" : ""}`,
		count("learn") && `${count("learn")} ready to learn`,
	].filter(Boolean);
	const first = actionable[0]!;
	const topics = new Set(actionable.map((i) => i.topicId));
	return {
		title: "LearnHarness — what next",
		body: `${parts.join(" · ")}. First: ${first.label}${topics.size > 1 ? "" : ` (${first.topicTitle})`}.`,
		url: topics.size === 1 ? `/topic/${first.topicId}` : "/",
		tag: "digest",
	};
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** One scheduler tick: past the digest time and not yet run today → send
 *  (or skip, when nothing waits) and remember the day. */
export async function digestTick(now = new Date(), sender?: PushSender): Promise<"sent" | "nothing" | "not-yet" | "done" | "no-devices"> {
	const record = read();
	if (localTime(now) < record.digestTime) return "not-yet";
	if (record.lastDigest === localDate(now)) return "done";
	write({ ...record, lastDigest: localDate(now) });
	if (!record.subscriptions.length) return "no-devices";
	const items = stores.topicStore.listTopics().flatMap((topic) => whatNext(topic, now.getTime()).map((item) => ({ ...item, topicTitle: topic.title })));
	const payload = digestPayload(items);
	if (!payload) return "nothing";
	await sendPush(payload, sender);
	return "sent";
}

const SCHEDULER = Symbol.for("lh.push.scheduler");
/** Started once at server boot (instrumentation.ts). */
export function startPushScheduler(): void {
	const g = globalThis as typeof globalThis & { [SCHEDULER]?: ReturnType<typeof setInterval> };
	if (g[SCHEDULER]) return;
	g[SCHEDULER] = setInterval(() => { void digestTick().catch((err) => console.error("[push] digest failed:", err)); }, 60_000);
	g[SCHEDULER].unref?.();
}

// ─── limit alerts ───────────────────────────────────────────────────────────

export function limitPushPayload(kind: "limited" | "lifted", until?: number): PushPayload {
	if (kind === "lifted") return { title: "ChatGPT usage reset", body: "Background work has resumed.", url: "/", tag: "chatgpt-limit" };
	const when = until ? new Date(until).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "the window resets";
	return { title: "ChatGPT plan limit reached", body: `Background work is paused until ${when}.`, url: "/", tag: "chatgpt-limit" };
}
