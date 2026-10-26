/** Client-safe status only. Credentials and OAuth transaction data never enter this contract. */
export interface ChatGPTStatus {
	available: boolean;
	pending: boolean;
	/** The OpenAI authorize URL of the pending paste-back sign-in. It carries
	 * only public PKCE/state values; the verifier never leaves the server. */
	signInUrl?: string;
	/** App-wide ChatGPT background permission, independent of account selection. */
	allowBackgroundUse: boolean;
	activeId: string | null;
	accounts: {
		id: string; email: string; registration: string; connected: boolean; planEnabled?: boolean;
		/** Server-owned authorization recovery eligibility. Missing means unknown, not eligible.
		 * False for storage failures, paused/closed connections, and healthy authorization. */
		canSignInAgain?: boolean;
	}[];
	error: string | null;
	catalogError?: string | null;
	/** ISO — the plan's usage limit was hit; background ChatGPT work is held
	 *  until then (absent = not limited). Foreground requests still go. */
	limitedUntil?: string;
}
export interface ChatGPTControlBridge {
	status(): Promise<ChatGPTStatus>;
	login(id?: string): Promise<ChatGPTStatus>;
	/** Finish the pending sign-in with the 127.0.0.1 callback address the
	 * browser was redirected to (it fails to load on the viewing device). */
	complete(callbackUrl: string): Promise<ChatGPTStatus>;
	cancel(): Promise<ChatGPTStatus>;
	select(id: string): Promise<ChatGPTStatus>;
	/** Explicitly forget every local registration/credential for this verified identity. */
	disconnect(id: string): Promise<ChatGPTStatus>;
	logout(id: string): Promise<ChatGPTStatus>;
	consent(enabled: boolean): Promise<ChatGPTStatus>;
	onChange(callback: () => void): () => void;
}

/** One plan-usage window (the 5-hour or weekly limit), as ChatGPT reports it. */
export interface ChatGPTUsageWindow {
	/** "5h", "week", or the window length in hours/days when unusual. */
	label: string;
	/** 0–100, how much of the window is used. */
	usedPercent: number;
	/** ISO — when the window resets (absent when not reported). */
	resetsAt?: string;
}

/** Live ChatGPT plan usage (web host, 2026-10-26 — owner decision). Read
 *  from ChatGPT's undocumented usage endpoint (the one behind Codex's
 *  /status) with the app's own sign-in; it may refuse or change, so
 *  `available: false` is a normal outcome and the UI falls back to the
 *  official usage page. */
export type ChatGPTPlanUsage =
	| { available: true; planType?: string; windows: ChatGPTUsageWindow[]; fetchedAt: string }
	| { available: false; reason: string };
