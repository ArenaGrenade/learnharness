/** Web/Docker composition. Upstream plugin initialization remains shared. */
export async function bootSelfHostedApp(): Promise<void> {
	const { connectionHost } = await import("./connections/host.ts");
	connectionHost();
	const { initializePlugins } = await import("../server/plugins.ts");
	try { await initializePlugins(); }
	catch (error) { console.error("[plugins] Initialization failed:", error); }
	const { startPushScheduler } = await import("./push.ts");
	startPushScheduler();
}
