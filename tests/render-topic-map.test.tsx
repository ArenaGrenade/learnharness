/** The topic map + targeted-session card render (topics wave, 2026-10-26). */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { TopicMap } from "../components/topic-map.tsx";
import { TopicTargetCard } from "../components/topic-target-card.tsx";
import type { ComponentStatus, TopicComponent } from "../src/core/index.ts";

const comp = (id: string, name: string, prerequisites: string[] = []): TopicComponent => ({ id, name, description: "d", prerequisites, createdAt: "2026-10-01T00:00:00.000Z" });

describe("TopicMap", () => {
	it("renders every component with its status, edges prerequisite → component, and the selection", () => {
		const statuses: Record<string, ComponentStatus> = { c_a: "held", c_b: "misconception", c_t: "unprobed" };
		const html = renderToStaticMarkup(
			<TopicMap components={[comp("c_a", "Exponentials"), comp("c_b", "Probability"), comp("c_t", "Softmax", ["c_a", "c_b"])]} statusOf={(id) => statuses[id]!} selected="c_b" onSelect={() => {}} />,
		);
		assert.match(html, /data-testid="topic-map"/);
		assert.match(html, /data-testid="topic-node-c_a" data-status="held"/);
		assert.match(html, /data-testid="topic-node-c_b" data-status="misconception"/);
		assert.match(html, /aria-label="Softmax: Not probed"/);
		assert.equal((html.match(/marker-end="url\(#topic-arrow\)"/g) ?? []).length, 2);
		assert.match(html, /stroke-red-400/);
		assert.match(html, /stroke-width="2"/, "the selected node is emphasized");
	});
});

describe("TopicTargetCard", () => {
	it("names the purpose and component and links back to the topic", () => {
		const html = renderToStaticMarkup(<TopicTargetCard data={{ topicId: "topic_t", topicTitle: "Transformers", componentId: "c_a", componentName: "Attention", purpose: "repair" }} />);
		assert.match(html, /Repairing <span class="text-foreground">Attention<\/span> from/);
		assert.match(html, /href="\/topic\/topic_t"/);
	});
});
