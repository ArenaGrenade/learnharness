import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export interface AccountModel {
 id: string;
 name: string;
 metadata?: {
  contextWindow: number;
  input: ("text" | "image")[];
  efforts: string[];
 };
}
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
/** Allowlist capability fields only: remote instructions/endpoints are never imported. */
export function parseAccountModels(raw: unknown): AccountModel[] {
 if (!Array.isArray(raw)) throw new Error("Invalid ChatGPT model catalog");
 const seen = new Set<string>();
 return raw.flatMap((value): AccountModel[] => {
  if (!value || typeof value !== "object") return [];
  const m = value as Record<string, unknown>;
  if (m.visibility !== "list" || m.supported_in_api === false || typeof m.slug !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(m.slug) || typeof m.display_name !== "string" || !m.display_name.trim() || seen.has(m.slug)) return [];
  seen.add(m.slug);
  const entry: AccountModel = { id: m.slug, name: m.display_name.slice(0, 200) };
  if (positive(m.context_window) && Array.isArray(m.input_modalities) && m.input_modalities.includes("text") && Array.isArray(m.supported_reasoning_levels)) {
   const efforts = [...new Set(m.supported_reasoning_levels.flatMap((r: unknown) => {
    if (!r || typeof r !== "object") return [];
    const e = (r as { effort?: unknown }).effort;
    return typeof e === "string" ? [e] : [];
   }))];
   entry.metadata = { contextWindow: m.context_window, input: m.input_modalities.includes("image") ? ["text", "image"] : ["text"], efforts };
  }
  return [entry];
 });
}
export function accountModel(entry: AccountModel, legacy: readonly Model<"openai-responses">[] = []): Model<"openai-responses"> | undefined {
 const metadata = entry.metadata;
 if (!metadata) {
  // Compatibility for older sparse catalogs, never required for newly described models.
  const known = legacy.find(m => m.id === entry.id && m.api === "openai-responses");
  return known ? { ...known, provider: "chatgpt", name: entry.name, headers: undefined, samplingParams: undefined, cost: {input:0,output:0,cacheRead:0,cacheWrite:0} } : undefined;
 }
 const thinkingLevelMap: ThinkingLevelMap = {};
 for (const level of levels) thinkingLevelMap[level] = metadata.efforts.includes(level) ? level : level === "off" && metadata.efforts.includes("none") ? "none" : null;
 // 0 means unknown, not a claimed output cap. ChatGPTPayload omits max_output_tokens.
 return { id: entry.id, name: entry.name, provider: "chatgpt", api: "openai-responses", baseUrl: "https://api.openai.com/v1", input: metadata.input, reasoning: metadata.efforts.some(e=>e!=="none" && e!=="off"), thinkingLevelMap, contextWindow: metadata.contextWindow, maxTokens: 0, cost: {input:0,output:0,cacheRead:0,cacheWrite:0} };
}
