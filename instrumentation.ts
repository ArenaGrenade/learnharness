/** Server boot (Next instrumentation: runs once per server instance, before
 * the first request). The connection host loads saved subscription
 * credentials and plugs them into the agent bridges, so background work
 * resumed after a restart sees the same connections a request would. */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { connectionHost } = await import("./src/server/connections/host.ts");
	connectionHost();
	// The daily What-next digest (push notifications).
	const { startPushScheduler } = await import("./src/server/push.ts");
	startPushScheduler();
}
