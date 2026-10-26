"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginForm({ next, configured }: { next: string; configured: boolean }) {
	const [passphrase, setPassphrase] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (busy || !passphrase) return;
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }) });
			if (response.ok) { window.location.replace(next); return; }
			const body = await response.json().catch(() => null) as { error?: unknown } | null;
			setError(typeof body?.error === "string" ? body.error : "Sign-in failed. Try again.");
		} catch { setError("The LearnHarness server could not be reached."); }
		setBusy(false);
	}
	return (
		<form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-card p-6" data-testid="login-form">
			<h1 className="font-title text-2xl tracking-tight">LearnHarness</h1>
			{configured ? <>
				<label htmlFor="lh-passphrase" className="text-xs text-muted-foreground">Passphrase</label>
				<Input id="lh-passphrase" type="password" autoComplete="current-password" autoFocus value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
				{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
				<Button type="submit" disabled={busy || !passphrase}>Sign in</Button>
			</> : <p className="text-sm text-muted-foreground" data-testid="login-unconfigured">
				No passphrase is set yet. On the computer running LearnHarness, run <code className="font-mono text-foreground">npm run set-passphrase</code>, then reload this page.
			</p>}
		</form>
	);
}
