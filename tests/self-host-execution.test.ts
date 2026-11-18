import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configuredLanguages, canonicalLanguage, runnerCapabilities, runRemoteTests } from "../plugins/coding-questions/src/remote-runner.ts";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.LH_EXECUTION_URL;
const originalToken = process.env.LH_EXECUTION_TOKEN;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.LH_EXECUTION_URL; else process.env.LH_EXECUTION_URL = originalUrl;
  if (originalToken === undefined) delete process.env.LH_EXECUTION_TOKEN; else process.env.LH_EXECUTION_TOKEN = originalToken;
});
const tests = { program: "python3", args: ["-"], code: "assert 1 + 1 == 2" };
function configured() { process.env.LH_EXECUTION_URL = "http://runner.invalid:8080"; process.env.LH_EXECUTION_TOKEN = "scratch-runner-token"; }

test("execution scope is exactly Python, CUDA, C++, Rust, including historical aliases", () => {
  assert.deepEqual(configuredLanguages.map(row => row.id), ["python", "cuda", "cpp", "rust"]);
  for (const [input, expected] of [["Python", "python"], ["C++", "cpp"], ["CUDA", "cuda"], ["rs", "rust"]]) assert.equal(canonicalLanguage(input!), expected);
  for (const input of ["javascript", "node", "bash", "java", "../../bin/sh"]) assert.equal(canonicalLanguage(input), undefined);
});
test("unconfigured/offline runner never falls back to executing an app process", async () => {
  delete process.env.LH_EXECUTION_URL; delete process.env.LH_EXECUTION_TOKEN;
  globalThis.fetch = async () => { assert.fail("No dispatch without runner configuration"); };
  await assert.rejects(runRemoteTests({ language: "python", answer: "pass", tests }), /local execution is disabled/);
  assert((await runnerCapabilities()).languages.every(row => !row.available));
});
test("unsupported languages and arbitrary executable recipes fail before transport", async () => {
  configured(); globalThis.fetch = async () => { assert.fail("Invalid execution must not dispatch"); };
  await assert.rejects(runRemoteTests({ language: "javascript", answer: "", tests }), /not enabled/);
  await assert.rejects(runRemoteTests({ language: "python", answer: "", tests: { ...tests, program: "sh" } }), /test driver/);
});
test("remote dispatch carries only language, submitted source and tests, using the private bearer", async () => {
  configured(); let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(String(url), "http://runner.invalid:8080/execute");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer scratch-runner-token");
    assert.deepEqual(JSON.parse(String(init?.body)), { language: "cpp", answer: "int main(){}", tests });
    assert.equal(init?.redirect, "error");
    return Response.json({ status: "passed", exitCode: 0, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false });
  };
  assert.equal((await runRemoteTests({ language: "C++", answer: "int main(){}", tests })).status, "passed");
  assert.equal(calls, 1);
});
test("UI/agent capability data is filtered to the configured registry and retains unavailability", async () => {
  configured();
  globalThis.fetch = async () => Response.json({ languages: [
    { id: "python", compilerAvailable: true, available: true, version: "Python scratch" },
    { id: "cuda", compilerAvailable: true, gpuAvailable: false, available: false, version: "CUDA scratch", reason: "GPU unavailable" },
    { id: "javascript", compilerAvailable: true, available: true, version: "not enabled" },
  ] });
  const value = await runnerCapabilities();
  assert.deepEqual(value.languages.map(row => row.id), ["python", "cuda", "cpp", "rust"]);
  assert(value.languages[0]!.available); assert(!value.languages[1]!.available); assert.equal(value.languages[1]!.reason, "GPU unavailable");
  assert(!value.languages[2]!.available); assert(!value.languages[3]!.available);
});
test("malformed success observations cannot be accepted as passed tests", async () => {
  configured(); globalThis.fetch = async () => Response.json({ status: "passed", exitCode: 1 });
  await assert.rejects(runRemoteTests({ language: "rust", answer: "fn main(){}", tests }), /invalid test result/);
});
