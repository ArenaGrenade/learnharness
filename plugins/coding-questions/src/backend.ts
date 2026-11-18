import type { PluginBackendContext } from "learnharness-plugin-api";
import { Type } from "typebox";
import { definition, instructions, practiceInstructions, problemDefinition, readTests } from "./contract.ts";
import { runRemoteTests, runnerCapabilities, configuredLanguages } from "./remote-runner.ts";

export function activate(ctx: PluginBackendContext): () => void {
  const unregisterCapabilities = ctx.handle("runner-capabilities", () => runnerCapabilities());
  const unregisterCapabilityTool = ctx.registerTools({ agents: ["teacher", "practice"], create: () => [{
    name: "execution_capabilities", label: "Execution languages", description: "Read actual Docker runner compiler versions and GPU readiness before posing a coding question or practice problem.",
    parameters: Type.Object({}),
    execute: async () => { const value = await runnerCapabilities(); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; },
  }] });
  const unregisterQuestion = ctx.registerQuestionType({
    ...definition,
    gradeAnswer(context) {
      if (typeof context.answer !== "string") throw new Error("Coding answers must be strings.");
      return runRemoteTests({
        language: String(context.input.payload.language),
        answer: context.answer,
        tests: readTests(context.input.payload),
        signal: context.signal,
      });
    },
  });
  const unregisterProblem = ctx.registerProblemType({
    ...problemDefinition,
    processSubmission(context) {
      if (typeof context.submission !== "string") throw new Error("Coding submissions must be strings.");
      return runRemoteTests({
        language: String(context.input.payload.language),
        answer: context.submission,
        tests: readTests(context.input.payload),
        signal: context.signal,
      });
    },
  });
  const unregisterPracticeInstructions = ctx.registerInstructions({ agents: ["practice"], text: practiceInstructions + "\nCall execution_capabilities before posing code and use only currently available languages. Configured execution languages: " + configuredLanguages.map(row => row.label).join(", ") + ". Tests run only in the separate Docker runner. Use tests.program=python3 and tests.args=[\"-\"]; write a Python driver that reads answer.txt and compiles C++, CUDA, or Rust if needed. Never invoke a local app process." });
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: instructions + "\nCall execution_capabilities before posing code and use only currently available languages. Configured execution languages: " + configuredLanguages.map(row => row.label).join(", ") + ". Tests run only in the separate Docker runner. Use tests.program=python3 and tests.args=[\"-\"]; write a Python driver that reads answer.txt and compiles C++, CUDA, or Rust if needed. Never invoke a local app process." });
  return () => {
    unregisterCapabilities();
    unregisterCapabilityTool();
    unregisterInstructions();
    unregisterPracticeInstructions();
    unregisterProblem();
    unregisterQuestion();
  };
}
