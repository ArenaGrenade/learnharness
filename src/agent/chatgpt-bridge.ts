import type { Model } from "@earendil-works/pi-ai";
import type { ChatGPTStatus } from "../core/contracts/chatgpt.ts";
import type { AdmissionScope, NoDispatchKind } from "./chatgpt-request-cycle.ts";
export type { ChatGPTStatus } from "../core/contracts/chatgpt.ts";
export interface Stamp { epoch: number; authorityRevision: number; revision: number }
interface StatusValue extends Stamp { status: ChatGPTStatus }
interface ModelsValue extends StatusValue { accountId: string | null; models: { id: string; name: string }[] }
interface LeaseValue extends Stamp { accessToken: string; accountId: string }
interface BridgeState {
 status: ChatGPTStatus; stamp: Stamp; models: Model<"openai-responses">[]; catalogAccount: string | null;
 host: ChatGPTHost | null; controllers: Map<AbortController, boolean>; listeners: Set<() => void>; catalogRequest: number;
}
/** The server's in-process credential owner (src/server/connections), plugged
 * in by the composition root. The agent layer never imports it directly. */
export interface ChatGPTHost { request(op: "status" | "models" | "lease" | "limit", fields: Record<string, unknown>): Promise<unknown> }
export interface ChatGPTStateChange { kind: "state"; stamp: Stamp; status: ChatGPTStatus; invalidate?: string }
const key = Symbol.for("lh.chatgpt.bridge");
const unavailable = (): ChatGPTStatus => ({ available: false, pending: false, allowBackgroundUse: true, activeId: null, accounts: [], error: null });
const validStamp = (s: Stamp) => s && [s.epoch, s.authorityRevision, s.revision].every((v) => Number.isSafeInteger(v) && v >= 0);
function hostConnected(): boolean { return bridge().host !== null; }
function bridge(): BridgeState {
 const global = globalThis as typeof globalThis & { [key]?: BridgeState };
 global[key] ??= { status: unavailable(), stamp: { epoch: 0, authorityRevision: 0, revision: 0 }, models: [], catalogAccount: null, host: null, controllers: new Map(), listeners: new Set(), catalogRequest: 0 };
 return global[key];
}
/** Install the credential host. Returns the disconnect, which fails every
 * in-flight stream closed exactly like a lost host. */
export function connectChatGPTHost(host: ChatGPTHost): () => void {
 const state = bridge();
 state.host = host;
 return () => {
  if (state.host !== host) return;
  state.host = null;
  state.status = unavailable(); clearCatalog(state); state.catalogRequest++;
  for (const controller of state.controllers.keys()) controller.abort("all");
  for (const listener of state.listeners) listener();
 };
}
/** Host state notifications, in emission order. */
export function acceptChatGPTChange(m: ChatGPTStateChange): void {
 const state = bridge();
 if (!state.host || m?.kind !== "state" || !validStamp(m.stamp) || m.stamp.revision < state.stamp.revision) return;
 acceptStatus(state, { ...m.stamp, status: m.status });
 if (m.invalidate === "all") { state.catalogRequest++; clearCatalog(state); }
 if (m.invalidate === "all" || m.invalidate === "background") {
  for (const [controller, background] of state.controllers) if (m.invalidate === "all" || background) controller.abort(m.invalidate === "all" ? "all" : "background");
 }
 for (const listener of state.listeners) listener();
}
function clearCatalog(state: BridgeState) { state.models = []; state.catalogAccount = null; }
function acceptStatus(state: BridgeState, value: StatusValue) {
 if (!validStamp(value) || value.revision < state.stamp.revision) return;
 if (value.epoch !== state.stamp.epoch || value.authorityRevision !== state.stamp.authorityRevision || value.status.activeId !== state.status.activeId) clearCatalog(state);
 state.status = value.status; state.stamp = { epoch: value.epoch, authorityRevision: value.authorityRevision, revision: value.revision };
}
/** In-process only. No HTTP credential route or renderer method. */
export async function chatGPTRequest<T>(op: "status" | "models" | "lease" | "limit", fields: Record<string, unknown> = {}): Promise<T> {
 const host = bridge().host;
 if (!host) throw new Error("The ChatGPT connection is unavailable in this process.");
 return await host.request(op, fields) as T;
}
export function chatGPTStatus(): ChatGPTStatus { return bridge().status; }
/** A request hit the plan's usage limit (web host, 2026-10-26): the host
 *  holds background work until the window resets. Fire-and-forget. */
export function reportChatGPTLimit(): void { void chatGPTRequest("limit").catch(() => {}); }
/** Held while the plan limit lasts (background only). */
function chatGPTLimited(s: ChatGPTStatus): boolean { return !!s.limitedUntil && Date.parse(s.limitedUntil) > Date.now(); }
export function chatGPTConnected(): boolean { const s = chatGPTStatus(); return hostConnected() && s.available && s.accounts.some((a) => a.id === s.activeId && a.connected && a.planEnabled === true); }
export function chatGPTBackgroundAllowed(): boolean { const s = chatGPTStatus(); return chatGPTConnected() && s.allowBackgroundUse === true && !chatGPTLimited(s); }
export function onChatGPTChange(listener: () => void): () => void { bridge().listeners.add(listener); return () => { bridge().listeners.delete(listener); }; }
export function chatGPTModels(): Model<"openai-responses">[] { return bridge().models; }
export function chatGPTModel(id: string): Model<"openai-responses"> | undefined { return chatGPTModels().find((m) => m.id === id); }
export function chatGPTScope(selectedModelId: string): AdmissionScope {
 const state = bridge();
 if (!chatGPTConnected() || !state.catalogAccount || state.catalogAccount !== state.status.activeId || !chatGPTModel(selectedModelId)) throw new Error("ChatGPT account model catalog is unavailable");
 return { accountId: state.catalogAccount, epoch: state.stamp.epoch, authorityRevision: state.stamp.authorityRevision, selectedModelId };
}
export function chatGPTScopeCurrent(scope: AdmissionScope): boolean {
 const s = bridge();
 return hostConnected() && chatGPTConnected() && scope.accountId === s.catalogAccount && scope.accountId === s.status.activeId && scope.epoch === s.stamp.epoch && scope.authorityRevision === s.stamp.authorityRevision && !!chatGPTModel(scope.selectedModelId);
}
export async function chatGPTLease(scope: AdmissionScope, background: boolean): Promise<LeaseValue> {
 if (!chatGPTScopeCurrent(scope)) throw new Error("ChatGPT catalog authority changed");
 const value = await chatGPTRequest<LeaseValue>("lease", { background, expectedAccountId: scope.accountId, expectedAuthorityRevision: scope.authorityRevision, selectedModelId: scope.selectedModelId });
 if (!validStamp(value) || !chatGPTScopeCurrent(scope) || value.epoch !== scope.epoch || value.authorityRevision !== scope.authorityRevision || value.accountId !== scope.accountId || typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.startsWith("sk-")) throw new Error("ChatGPT lease is stale");
 return value;
}
/** Safe status confirmation can establish consent-only denial, never parse error text. */
export async function chatGPTDenial(scope: AdmissionScope | undefined, controller: AbortController, callerAborted: boolean, background: boolean): Promise<NoDispatchKind> {
 if (callerAborted || controller.signal.reason === "all") return "all";
 if (!scope || !chatGPTScopeCurrent(scope)) return "other";
 if (controller.signal.reason === "background") return "background";
 if (!background) return "other";
 try { const value = await chatGPTRequest<StatusValue>("status"); acceptStatus(bridge(), value); }
 catch { return "other"; }
 if (controller.signal.reason === "all" || !chatGPTScopeCurrent(scope)) return "all";
 return !chatGPTBackgroundAllowed() ? "background" : "other";
}
/** Preserve account order; unknown capabilities/windows are never fabricated. */
export async function refreshChatGPTModels(supported: Model<"openai-responses">[]): Promise<void> {
 const state = bridge();
 if (!hostConnected()) { clearCatalog(state); return; }
 const sequence = ++state.catalogRequest;
 try {
  const value = await chatGPTRequest<ModelsValue>("models");
  if (sequence !== state.catalogRequest || !validStamp(value)) return;
  acceptStatus(state, value);
  if (value.epoch !== state.stamp.epoch || value.authorityRevision !== state.stamp.authorityRevision || value.accountId !== state.status.activeId || !chatGPTConnected()) return;
  state.catalogAccount = value.accountId;
  state.models = value.models.flatMap((entry) => {
   const known = supported.find((m) => m.id === entry.id && m.api === "openai-responses");
   return known ? [{ ...known, provider: "chatgpt", name: entry.name, headers: undefined, samplingParams: undefined, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] : [];
  });
 } catch { if (sequence === state.catalogRequest) clearCatalog(state); }
}
export function chatGPTAbortController(background = true): { controller: AbortController; release: () => void } {
 const state = bridge(); const controller = new AbortController(); state.controllers.set(controller, background);
 return { controller, release: () => { state.controllers.delete(controller); } };
}
