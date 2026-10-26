/**
 * Set (or change) the single-user passphrase: `npm run set-passphrase`.
 * Writes data/credentials/access.json (0600; LH_DATA_DIR relocates it) and
 * rotates the session key, so every signed-in browser must sign in again.
 * Interactive input is not echoed; piped input reads the first line.
 */
import { ACCESS_FILE, writePassphrase } from "../src/server/access.ts";

function readHidden(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		return new Promise((resolve, reject) => {
			let data = "";
			stdin.setEncoding("utf8");
			stdin.on("data", (chunk) => { data += chunk; });
			stdin.on("end", () => resolve(data.split(/\r?\n/)[0] ?? ""));
			stdin.on("error", reject);
		});
	}
	process.stdout.write(prompt);
	return new Promise((resolve) => {
		let value = "";
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
					process.stdout.write("\n");
					resolve(value);
					return;
				}
				if (char === "\u0003") { process.stdout.write("\n"); process.exit(130); }
				if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
				else value += char;
			}
		};
		stdin.on("data", onData);
	});
}

const first = await readHidden("New passphrase: ");
if (process.stdin.isTTY) {
	const second = await readHidden("Repeat it: ");
	if (first !== second) { console.error("The passphrases do not match. Nothing was changed."); process.exit(1); }
}
try {
	await writePassphrase(first);
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
}
console.log(`Passphrase saved to ${ACCESS_FILE}. Every browser session has been signed out.`);
