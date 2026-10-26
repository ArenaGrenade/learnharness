"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

/**
 * NOTIFICATIONS (web host, 2026-10-26): Web Push on this device — the daily
 * What-next digest and ChatGPT limit alerts. The service worker is
 * registered at /sw.js; the server holds the VAPID keys and subscriptions.
 * iOS delivers push only to the INSTALLED app (Share → Add to Home Screen),
 * so the section says so when it runs in a plain Safari tab.
 */

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
	const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded);
	const out = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

/** A short label for this device in the server's list. */
export function deviceLabel(userAgent: string): string {
	const os = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android" : /Mac OS X/.test(userAgent) ? "Mac" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "Device";
	const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "browser";
	return `${os} · ${browser}`;
}

type Support = "checking" | "ok" | "unsupported" | "ios-not-installed";

export function NotificationsSection() {
	const [support, setSupport] = useState<Support>("checking");
	const [subscription, setSubscription] = useState<PushSubscription | null>(null);
	const [digestTime, setDigestTime] = useState("09:00");
	const [devices, setDevices] = useState<Array<{ endpoint: string; label: string }>>([]);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const readServer = useCallback(async () => {
		const response = await fetch("/api/push", { cache: "no-store" }).catch(() => null);
		if (!response?.ok) return null;
		const body = await response.json() as { publicKey: string; digestTime: string; devices: Array<{ endpoint: string; label: string }> };
		setDigestTime(body.digestTime); setDevices(body.devices);
		return body;
	}, []);

	useEffect(() => {
		void readServer();
		const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
		if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) { setSupport("ios-not-installed"); return; }
		if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { setSupport("unsupported"); return; }
		setSupport("ok");
		void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
			.then((registration) => registration.pushManager.getSubscription())
			.then(setSubscription)
			.catch(() => setSupport("unsupported"));
	}, [readServer]);

	async function enable() {
		setBusy(true); setMessage("Turning on… (registering with the browser's push service can take a few seconds)");
		try {
			// Ask only when not decided yet (a granted origin never re-prompts).
			const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
			if (permission !== "granted") { setMessage("Notifications are blocked for this site — allow them in the browser's settings."); return; }
			const server = await readServer();
			if (!server) throw new Error("server");
			const registration = await navigator.serviceWorker.ready;
			const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(server.publicKey) });
			const response = await fetch("/api/push/subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), label: deviceLabel(navigator.userAgent) }) });
			if (!response.ok) throw new Error("subscribe");
			setSubscription(sub);
			setMessage(null);
			await readServer();
		} catch {
			setMessage("Notifications could not be turned on. Try again.");
		} finally { setBusy(false); }
	}

	async function disable() {
		if (!subscription) return;
		setBusy(true); setMessage(null);
		try {
			await fetch("/api/push/subscription", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
			await subscription.unsubscribe();
			setSubscription(null);
			await readServer();
		} catch { setMessage("Notifications could not be turned off. Try again."); }
		finally { setBusy(false); }
	}

	async function saveTime(value: string) {
		setDigestTime(value);
		const response = await fetch("/api/push", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ digestTime: value }) }).catch(() => null);
		if (!response?.ok) setMessage("The digest time could not be saved.");
	}

	async function test() {
		setBusy(true); setMessage(null);
		const response = await fetch("/api/push/test", { method: "POST" }).catch(() => null);
		const body = response?.ok ? await response.json() as { sent: number } : null;
		setMessage(body ? (body.sent ? `Sent to ${body.sent} device${body.sent > 1 ? "s" : ""}.` : "No device received it.") : "The test could not be sent.");
		setBusy(false);
	}

	return (
		<div className="space-y-3 text-xs" data-testid="notifications-section">
			<p className="text-muted-foreground">A daily digest of what is waiting across your topics (only when something is), and an alert when the ChatGPT plan limit is hit and when it resets.</p>
			{support === "ios-not-installed" && <p className="text-amber-300" data-testid="notifications-ios-hint">On iPhone and iPad, notifications only work in the installed app: tap Share → Add to Home Screen, open LearnHarness from the home screen, then turn them on here.</p>}
			{support === "unsupported" && <p className="text-muted-foreground">This browser does not support push notifications.</p>}
			{support === "ok" && (
				<div className="flex items-center gap-3 text-foreground">
					<Toggle label="Notifications on this device" checked={!!subscription} disabled={busy} onChange={(on) => void (on ? enable() : disable())} />
					<span>Notifications on this device</span>
				</div>
			)}
			<label className="flex items-center gap-3 text-foreground">
				<span>Daily digest at</span>
				<input type="time" value={digestTime} onChange={(event) => void saveTime(event.target.value)} className="rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs" data-testid="digest-time" />
				<span className="text-muted-foreground">(server time)</span>
			</label>
			{devices.length > 0 && (
				<div className="space-y-1">
					<p className="text-muted-foreground/70">Devices receiving notifications</p>
					{devices.map((d) => <p key={d.endpoint} className="text-muted-foreground">{d.label}{subscription?.endpoint === d.endpoint ? " (this device)" : ""}</p>)}
					<Button variant="ghost" size="xs" disabled={busy} onClick={() => void test()}>Send a test</Button>
				</div>
			)}
			{message && <p role="status" className="text-muted-foreground">{message}</p>}
		</div>
	);
}
