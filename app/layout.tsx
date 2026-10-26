import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
	// The installable app (web host, 2026-10-26): iOS needs the
	// apple-web-app flags and touch icon to run it standalone (and push).
	applicationName: "LearnHarness",
	appleWebApp: { capable: true, title: "LearnHarness", statusBarStyle: "black-translucent" },
	icons: { icon: "/favicon-32.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#141414", viewportFit: "cover" };

/** The document shell only. The app chrome (event channel, sidebar, docks)
 * lives in app/(app)/layout.tsx so /login renders without it. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">{children}</body>
		</html>
	);
}
