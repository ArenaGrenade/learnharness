import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginBackendContext, PluginProblemProcessingContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { readTestResult } from "../src/test-result.ts";

test("registered processSubmission dispatches exact source, returns observations and honors cancellation", async (t) => {
  let run!: (context: PluginProblemProcessingContext) => unknown;
  const capture = (value: { processSubmission: typeof run }) => { run = value.processSubmission; return () => {}; };
  const cleanup = activate({
    handle() { return () => {}; }, registerTools() { return () => {}; },
    registerQuestionType() { return () => {}; },
    registerProblemType: capture,
    registerInstructions() { return () => {}; },
  } as unknown as PluginBackendContext);
  t.after(cleanup);
  const previous = { url: process.env.LH_EXECUTION_URL, token: process.env.LH_EXECUTION_TOKEN };
  process.env.LH_EXECUTION_URL = "http://runner.invalid";
  process.env.LH_EXECUTION_TOKEN = "test-private-token";
  t.after(() => {
    if(previous.url===undefined)delete process.env.LH_EXECUTION_URL;else process.env.LH_EXECUTION_URL=previous.url;
    if(previous.token===undefined)delete process.env.LH_EXECUTION_TOKEN;else process.env.LH_EXECUTION_TOKEN=previous.token;
  });
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(String(url), "http://runner.invalid/execute");
    init.signal!.throwIfAborted();
    const body = JSON.parse(String(init.body)); bodies.push(body);
    const passed = body.answer.includes("x*x");
    return Response.json({ status: passed ? "passed" : "failed", exitCode: passed ? 0 : 1, signal: null, stdout: "observed", stderr: "", durationMs: 3, stdoutTruncated: false, stderrTruncated: false });
  });
  const controller = new AbortController();
  const payload = { language: "Python", tests: { program: "python3", args: ["-"], code: "exec(open('answer.txt').read()); assert square(3)==9" } };
  const input = { statement: "Square", mode: "composition" as const, modelSolution: "PRIVATE_SOLUTION", payload };
  const context = { chatId: "fixture", problemId: "fixture", contractVersion: 1, input, submission: "  def square(x): return x*x\n", signal: controller.signal, thinking: "PRIVATE_THINKING" } as unknown as PluginProblemProcessingContext;
  assert.equal(readTestResult(await run(context))?.status, "passed");
  assert.deepEqual(bodies[0], { language: "python", answer: "  def square(x): return x*x\n", tests: payload.tests });
  assert.equal(readTestResult(await run({ ...context, submission: "def square(x): return x" }))?.status, "failed");
  await assert.rejects(Promise.resolve().then(() => run({ ...context, input: { ...input, payload: { ...payload, language: "javascript" } } })), /not enabled/);
  controller.abort();
  await assert.rejects(Promise.resolve().then(() => run(context)), { name: "AbortError" });
});
