/**
 * Topics — the server seam (topics wave, 2026-10-26): creating a topic with
 * its mapping conversation, starting check-ups, deleting. Status, progress
 * and What next are pure core (core/topic.ts) and computed by whoever
 * reads a record — the routes serve records only.
 */
import { stores } from "./stores.ts";
import { stampSessionModel } from "./chats.ts";
import type { TopicRecord } from "../core/contracts.ts";
import { componentState, newTopicTargetMessage } from "../core/topic.ts";

export class TopicRequestError extends Error {
	constructor(message: string, readonly status: number) { super(message); }
}

export const newTopicId = () => `topic_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;

/** A new topic + its mapping conversation (kind "topic", mode "map"). The
 *  client opens the chat with the learner's target as the first message. */
export function createTopic(title: string): { topic: TopicRecord; chatId: string } {
	const clean = title.trim();
	if (!clean) throw new TopicRequestError("Name the topic you want to learn.", 400);
	if (clean.length > 200) throw new TopicRequestError("Keep the topic name under 200 characters.", 400);
	const id = newTopicId();
	const chat = stores.chatStore.createChat(clean, "topic", { topicId: id, mode: "map" });
	stampSessionModel(chat.id);
	const topic = stores.topicStore.createTopic({ id, title: clean, mapChatId: chat.id });
	return { topic, chatId: chat.id };
}

export function listTopics(): TopicRecord[] {
	return stores.topicStore.listTopics();
}

export function getTopic(id: string): TopicRecord | null {
	try { return stores.topicStore.getTopic(id); } catch { return null; }
}

/** A short check-up conversation for one component. */
export function startCheckup(topicId: string, componentId: string): { chatId: string } {
	const topic = getTopic(topicId);
	if (!topic) throw new TopicRequestError("Topic not found.", 404);
	const component = topic.components.find((c) => c.id === componentId);
	if (!component) throw new TopicRequestError("Component not found.", 404);
	const chat = stores.chatStore.createChat(`Check-up: ${component.name}`, "topic", { topicId, mode: "checkup", componentId });
	stampSessionModel(chat.id);
	return { chatId: chat.id };
}

/** A TEACHING session for one component (learn the frontier or repair a
 *  misconception): a normal session — probe, plan, teach, extraction into
 *  the graph — whose message[0] is the topic-target context marker. Its
 *  probe_done and lesson_complete report back to the topic. */
export function startLearning(topicId: string, componentId: string, purpose: "learn" | "repair"): { chatId: string; prompt: string } {
	const topic = getTopic(topicId);
	if (!topic) throw new TopicRequestError("Topic not found.", 404);
	const component = topic.components.find((c) => c.id === componentId);
	if (!component) throw new TopicRequestError("Component not found.", 404);
	const chat = stores.chatStore.createChat(component.name, undefined, undefined, { topicId, componentId, purpose });
	stampSessionModel(chat.id);
	stores.chatStore.saveMessages(chat.id, [newTopicTargetMessage(topic, componentId, purpose)]);
	const status = componentState(topic, componentId).status;
	const prompt = purpose === "repair"
		? `I want to fix my understanding of ${component.name}.`
		: status === "shaky" ? `I want to strengthen my understanding of ${component.name}.` : `I want to learn ${component.name}: ${component.description}`;
	return { chatId: chat.id, prompt };
}

/** Delete a topic and its own conversations (mapping + check-ups). Teaching
 *  sessions started from it are real sessions and stay. */
export function deleteTopic(id: string): boolean {
	if (!getTopic(id)) return false;
	for (const summary of stores.chatStore.listChats()) {
		if (summary.kind !== "topic") continue;
		const chat = stores.chatStore.getChat(summary.id);
		if (chat?.topic?.topicId === id) stores.chatStore.deleteChat(summary.id);
	}
	return stores.topicStore.deleteTopic(id);
}
