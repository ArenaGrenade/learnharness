import type { PluginFrontendContext } from "learnharness-plugin-api";
import { canonicalLanguage, type RunnerCapabilities } from "./remote-runner.ts";

/** Both settings and the editor read the backend's actual runner capabilities. */
export async function showRunnerCapabilities(container: HTMLElement, ctx: PluginFrontendContext, signal: AbortSignal, language?: string): Promise<boolean> {
  const status = document.createElement("div");
  status.className = "text-xs text-muted-foreground mb-3 whitespace-pre-wrap";
  status.setAttribute("data-testid", "execution-capabilities");
  status.textContent = "Checking execution runner…";
  container.append(status);
  try {
    const result = await ctx.call<RunnerCapabilities>("runner-capabilities");
    if (signal.aborted) return false;
    if (!result || !Array.isArray(result.languages)) throw new Error("Invalid runner status");
    status.textContent = result.languages.map(row => `${row.label}: ${row.available ? "available" : "unavailable"}${row.gpuAvailable === false ? " (GPU execution unavailable)" : ""}${row.version ? ` — ${(row.version.split("\n").find(line => /release|rustc|Python|g\+\+/.test(line)) ?? row.version.split("\n")[0])}` : ""}${row.reason ? ` — ${row.reason}` : ""}`).join("\n");
    return language === undefined || result.languages.some(row => row.id === canonicalLanguage(language) && row.available === true);
  } catch {
    if (!signal.aborted) status.textContent = "Execution runner unavailable. Code cannot be submitted until the runner is ready.";
    return false;
  }
}
