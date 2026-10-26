import type { MetadataRoute } from "next";

/** The installable app (web host, 2026-10-26): add to the home screen on a
 *  phone — iOS only allows push notifications for installed web apps. */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "Adaptive teaching, practice, and a persistent knowledge graph.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
			{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
