/** Server-injected private web transport. The agent layer never imports a
 * filesystem owner or server composition root. Desktop IPC remains separate. */
export type SubscriptionRuntimeChannel = "lh:chatgpt" | "lh:subscriptions";
export type SubscriptionRuntimePacket = Record<string, unknown>;
interface Runtime {
	hosts: Map<SubscriptionRuntimeChannel, PrivateSubscriptionHost>;
	request?: <T>(channel: SubscriptionRuntimeChannel, op: string, fields: Record<string, unknown>) => Promise<T>;
	listeners: Map<SubscriptionRuntimeChannel, Set<(packet: SubscriptionRuntimePacket) => void>>;
}
const KEY = Symbol.for("lh.webSubscriptionRuntime");
function runtime(): Runtime {
	const global = globalThis as typeof globalThis & { [KEY]?: Runtime };
	return global[KEY] ??= { listeners: new Map(), hosts: new Map() };
}
export function configureWebSubscriptionRuntime(request: NonNullable<Runtime["request"]>): void { runtime().request = request; }
export function webSubscriptionsEnabled(): boolean {
	return process.env.LH_DESKTOP_SERVER !== "1" && !process.env.LH_DESKTOP_API_SECRET && (!!runtime().request || runtime().hosts.size > 0);
}
export function onWebSubscriptionPacket(channel: SubscriptionRuntimeChannel, listener: (packet: SubscriptionRuntimePacket) => void): void {
	const state = runtime(); const listeners = state.listeners.get(channel) ?? new Set();
	listeners.add(listener); state.listeners.set(channel, listeners);
}
export function publishWebSubscriptionPacket(channel: SubscriptionRuntimeChannel, packet: SubscriptionRuntimePacket): void {
	for (const listener of runtime().listeners.get(channel) ?? []) {
		try { listener(packet); } catch { /* observer isolation */ }
	}
}
export function webSubscriptionRequest<T>(channel: SubscriptionRuntimeChannel, op: string, fields: Record<string, unknown>): Promise<T> {
	if (!webSubscriptionsEnabled()) return Promise.reject(new Error("The web subscription owner is unavailable."));
	const host = runtime().hosts.get(channel);
	if (host) return host.request(op, fields) as Promise<T>;
	return runtime().request!<T>(channel, op, fields);
}

export interface PrivateSubscriptionHost { request(op: string, fields: Record<string, unknown>): Promise<unknown> }
export function connectPrivateSubscriptionHost(channel: SubscriptionRuntimeChannel, host: PrivateSubscriptionHost): () => void { runtime().hosts.set(channel, host); return () => { if (runtime().hosts.get(channel) === host) runtime().hosts.delete(channel); }; }

export function hasPrivateSubscriptionHost(): boolean { return runtime().hosts.size > 0; }
