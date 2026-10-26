import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useModelCatalog, catalogLimits } from "../components/model-picker.tsx";
import { useZeroKeys, useStrongKeyless } from "../components/setup-cta.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { SidebarProvider } from "../components/sidebar.tsx";
import { ChatGPTConnection, ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { connectionBridges, httpChatGPTBridge } from "../components/connection-bridges.ts";
import { GraphCostControl } from "../components/graph-view.tsx";
import { graphCostSummary as foldGraphCostSummary, type CostSummaryInput } from "../src/core/cost-summary.ts";
const graphCostSummary = (input: CostSummaryInput) => foldGraphCostSummary(input, () => null);
import type { ModelCatalogResponse, ChatGPTStatus } from "../src/core/index.ts";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
// linkedom has no media queries; the sidebar asks whether it is a phone.
Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function body(id: string, ready = true): ModelCatalogResponse {
 return { models: ready ? [{ id, name: id, provider: "chatgpt", input: ["text"], contextWindow: 8192, maxTokens: 1024, reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] : [], providers: [{ id: "chatgpt", envVar: "", keyPresent: ready }], slots: { strong: { model: { provider: "chatgpt", id: "explicit-pin" } }, cheap: null, vision: null }, defaults: {} } as ModelCatalogResponse;
}
let snapshots: Record<string, { catalog?: ModelCatalogResponse; zero: boolean; strong: boolean }> = {};
function Reader({ id }: { id: string }) {
 const { catalog } = useModelCatalog();
 snapshots[id] = { catalog, zero: useZeroKeys(), strong: useStrongKeyless() };
 return <span data-testid={id}>{catalog ? [...catalogLimits(catalog).keys()].join(",") : "unavailable"}</span>;
}
async function mount(children: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(children)); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; connectionBridges.chatgpt = httpChatGPTBridge; snapshots = {}; });

test("shared ChatGPT-only readiness admits without API keys; connection invalidation clears every reader and fences old success/error", async () => {
 const requests: ReturnType<typeof deferred<Response>>[] = [];
 globalThis.fetch = async (input) => { assert.equal(input, "/api/models"); const request = deferred<Response>(); requests.push(request); return request.promise; };
 await mount(<><Reader id="first" /><Reader id="second" /></>);
 assert.equal(requests.length, 1);
 await act(async () => requests[0]!.resolve(Response.json(body("A"))));
 for (const value of Object.values(snapshots)) { assert.equal(value.zero, false); assert.equal(value.strong, false); assert.equal(value.catalog?.models[0]?.id, "A"); }
 await act(async () => notifySettingsSaved("models"));
 assert.equal(requests.length, 2);
 await act(async () => notifySettingsSaved("keys"));
 assert.equal(requests.length, 3);
 for (const value of Object.values(snapshots)) assert.equal(value.catalog, undefined);
 await act(async () => requests[2]!.resolve(Response.json(body("B", false))));
 await act(async () => requests[1]!.resolve(Response.json(body("stale-A"))));
 for (const value of Object.values(snapshots)) { assert.equal(value.catalog?.models.length, 0); assert.equal(value.zero, true); assert.equal(value.strong, true); }
 assert(!document.body.textContent?.includes("chatgpt:A"));
});

test("plan plus unknown graph rows keep the existing unknown suffix without fabricating API dollars", async () => {
 const step = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
 const plan = { model: "chatgpt:gpt-5", steps: [step] };
 const unknown = { model: "unknown:missing", steps: [step] };
 const costs = graphCostSummary({ chats: [{ title: "Scratch", extractions: [{ startedAt: 1, at: "2026-10-24T00:00:00Z", durationMs: 1, stages: { extractor: plan, auditor: unknown } }, { startedAt: 2, at: "2026-10-24T00:00:00Z", durationMs: 1, stages: { extractor: unknown, auditor: plan } }] }], sources: [] });
 await mount(<GraphCostControl costs={costs} />);
 await act(async () => { document.querySelector("button")!.click(); });
 const recent = [...document.querySelectorAll(".border-t .shrink-0.tabular-nums")];
 assert.equal(recent.length, 2);
 for (const row of recent) assert.equal(row.textContent, "ChatGPT +1 unpriced", "both recent two-stage runs disclose their unknown stage");
 assert.equal((document.body.textContent?.match(/\+1 unpriced/g) ?? []).length, 4, "both mixed stage rows also retain their unknown suffix");
 assert(!document.body.textContent?.includes("$0.00"));
});

test("root-lifetime relay publishes connection changes with Connections unmounted; the panel's own refresh never duplicates global signals", async () => {
 const frames = new Map<string, (data: string) => void>();
 const source: NotifySource = { close() {}, onOpen() {}, onEvent: (name, cb) => { frames.set(name, cb); } };
 const changed = () => act(async () => { frames.get("connections-changed")!("{}"); });
 let statusReads = 0, fetches = 0;
 const safe: ChatGPTStatus = { available: true, pending: false, allowBackgroundUse: false, activeId: "a", accounts: [{ id: "a", email: "dummy@example.invalid", registration: "oaiapp_dummy", connected: true, planEnabled: true }], error: null };
 connectionBridges.chatgpt = { ...httpChatGPTBridge, status: async () => { statusReads++; return safe; } };
 globalThis.fetch = async (input) => { assert.equal(input, "/api/models"); fetches++; return Response.json(body(`model-${fetches}`)); };
 const app = (panel: boolean) => <ServerEventsProvider connect={() => source}><SidebarProvider><Reader id="root" />{panel && <ChatGPTUIProvider><ChatGPTConnection /></ChatGPTUIProvider>}</SidebarProvider></ServerEventsProvider>;
 await mount(app(false));
 const before = fetches;
 await changed();
 assert.equal(fetches, before + 1, "the sidebar relay re-reads key-gated surfaces with no panel mounted");
 await act(async () => root!.render(app(true)));
 const mounted = fetches, reads = statusReads;
 await changed();
 assert.equal(fetches, mounted + 1, "one global publisher even when the panel also refreshes");
 assert.equal(statusReads, reads + 1, "the mounted panel re-reads its status once");
 await act(async () => root!.render(app(false)));
 await changed();
 assert.equal(fetches, mounted + 2);
 assert.equal(statusReads, reads + 1, "an unmounted panel stops listening");
});
