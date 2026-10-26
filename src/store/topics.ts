/**
 * TopicStore — the fs JSON adapter (topics wave, 2026-10-26): one file per
 * topic in data/topics/. Implements core/ports.ts TopicStore. Idioms match
 * the job store: sync fs, id-guarded filenames, tab-indented JSON. Writes
 * go temp-file + rename so a crash never leaves a half-written topic; the
 * read-modify-write sections contain no awaits (atomic within the event
 * loop). Every write announces topics-changed AFTER it lands.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { TopicStore } from "../core/ports.ts";
import type { TopicComponent, TopicEvidence, TopicRecord } from "../core/contracts.ts";

const TOPICS_DIR = path.join(PATHS.data, "topics");

function topicFile(id: string): string {
	if (!/^topic_[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid topic id: ${id}`);
	return path.join(TOPICS_DIR, `${id}.json`);
}

function write(record: TopicRecord): TopicRecord {
	fs.mkdirSync(TOPICS_DIR, { recursive: true });
	const file = topicFile(record.id);
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(record, null, "\t"), "utf-8");
	fs.renameSync(temp, file);
	emit("topics-changed", { topicId: record.id });
	return record;
}

function getTopic(id: string): TopicRecord | null {
	try {
		return JSON.parse(fs.readFileSync(topicFile(id), "utf-8")) as TopicRecord;
	} catch {
		return null;
	}
}

function update(id: string, change: (record: TopicRecord) => TopicRecord): TopicRecord | null {
	const record = getTopic(id);
	if (!record) return null;
	return write({ ...change(record), updatedAt: new Date().toISOString() });
}

export const topicStore: TopicStore = {
	createTopic({ id, title, mapChatId, source }) {
		const now = new Date().toISOString();
		return write({
			...(source ? { source } : {}),
			id,
			title: title.trim() || "Untitled topic",
			mapChatId,
			components: [],
			evidence: [],
			createdAt: now,
			updatedAt: now,
		});
	},
	getTopic,
	listTopics() {
		try {
			fs.mkdirSync(TOPICS_DIR, { recursive: true });
			return fs.readdirSync(TOPICS_DIR)
				.filter((f) => f.endsWith(".json"))
				.map((f) => getTopic(f.slice(0, -5)))
				.filter((t): t is TopicRecord => t !== null)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		} catch {
			return [];
		}
	},
	saveComponents(id, components: TopicComponent[], goal?: string) {
		return update(id, (record) => ({ ...record, components, ...(goal?.trim() ? { goal: goal.trim() } : {}) }));
	},
	appendEvidence(id, evidence: TopicEvidence) {
		return update(id, (record) => ({ ...record, evidence: [...record.evidence, evidence] }));
	},
	markMapped(id, at) {
		return update(id, (record) => ({ ...record, mappedAt: at }));
	},
	updateSource(id, patch, title) {
		return update(id, (record) => record.source ? ({ ...record, ...(title?.trim() ? { title: title.trim().slice(0, 200) } : {}), source: { ...record.source, ...patch } }) : record);
	},
	deleteTopic(id) {
		try {
			fs.rmSync(topicFile(id));
			emit("topics-changed", { topicId: id });
			return true;
		} catch {
			return false;
		}
	},
};
