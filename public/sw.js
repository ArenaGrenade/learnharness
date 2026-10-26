/* LearnHarness service worker (web host, 2026-10-26): push notifications
   only — no caching, no offline mode. A push shows the notification; a tap
   focuses an open window (navigating it) or opens one. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = {};
	try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
	event.waitUntil(self.registration.showNotification(data.title || "LearnHarness", {
		body: data.body || "",
		tag: data.tag || undefined,
		icon: "/icon-192.png",
		badge: "/icon-192.png",
		data: { url: data.url || "/" },
	}));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		for (const client of windows) {
			if (new URL(client.url).origin === self.location.origin && "focus" in client) {
				await client.focus();
				if ("navigate" in client) await client.navigate(url).catch(() => {});
				return;
			}
		}
		await self.clients.openWindow(url);
	})());
});
