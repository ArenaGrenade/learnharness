/**
 * Loaded before every test file (`npm test` passes --import). Points the
 * data-location and key-file seams at a fresh temp directory BEFORE any
 * module reads config.ts — static imports are hoisted, so a test that sets
 * LH_DATA_DIR in its own body can be too late, and tests that never set it
 * would otherwise write chats, jobs and graph files into the real data/.
 * A test may still choose its own scratch dir; this is only the floor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-data-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
