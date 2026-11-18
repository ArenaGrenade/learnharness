import registry from "../runner/languages.json" with { type: "json" };
import { readTestResult, type CodingTestResult, type CodingTests } from "./test-result.ts";

export interface LanguageCapability {
  id: string; label: string; aliases: string[]; available: boolean;
  compilerAvailable: boolean; gpuAvailable?: boolean; version: string | null; reason?: string;
}
export interface RunnerCapabilities { languages: LanguageCapability[] }
export const configuredLanguages = registry.map(({ id, label, aliases }) => ({ id, label, aliases }));

export function canonicalLanguage(language: string): string | undefined {
  const name = language.trim().toLowerCase();
  return registry.find(row => row.id === name || row.label.toLowerCase() === name || row.aliases.includes(name))?.id;
}
function offline(): RunnerCapabilities {
  return { languages: registry.map(row => ({ ...row, available: false, compilerAvailable: false, version: null, reason: "Execution runner is unavailable." })) };
}
async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const base = process.env.LH_EXECUTION_URL;
  const token = process.env.LH_EXECUTION_TOKEN;
  if (!base || !token) throw new Error("Execution runner is not configured; local execution is disabled.");
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Execution runner refused the request (HTTP ${response.status}).`);
  return response.json();
}
export async function runnerCapabilities(): Promise<RunnerCapabilities> {
  try {
    const value = await request("/capabilities") as RunnerCapabilities;
    if (!value || !Array.isArray(value.languages)) return offline();
    return { languages: registry.map(configured => {
      const row = value.languages.find(row => row.id === configured.id);
      if (!row || typeof row.available !== "boolean" || typeof row.compilerAvailable !== "boolean" || !(row.version === null || typeof row.version === "string")) return offline().languages.find(row => row.id === configured.id)!;
      return { ...configured, available: row.available, compilerAvailable: row.compilerAvailable, version: row.version, ...(typeof row.gpuAvailable === "boolean" ? { gpuAvailable: row.gpuAvailable } : {}), ...(typeof row.reason === "string" ? { reason: row.reason } : {}) };
    }) };
  } catch { return offline(); }
}
export async function runRemoteTests(options: { language: string; answer: string; tests: CodingTests; signal?: AbortSignal }): Promise<CodingTestResult> {
  const language = canonicalLanguage(options.language);
  if (!language) throw new Error("This language is not enabled in the execution runner.");
  if (options.tests.program !== "python3" || options.tests.args.length !== 1 || options.tests.args[0] !== "-") throw new Error("Use python3 with args ['-'] for the test driver. Compile C++, CUDA, or Rust inside that driver.");
  const result = readTestResult(await request("/execute", { language, answer: options.answer, tests: options.tests }, options.signal));
  if (!result) throw new Error("Execution runner returned an invalid test result.");
  return result;
}
