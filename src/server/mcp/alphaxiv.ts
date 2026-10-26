/**
 * alphaXiv research-paper tools for the researcher sub-agent (web host,
 * 2026-10-26) — the alphaXiv MCP server (https://www.alphaxiv.org/docs/mcp)
 * over streamable HTTP with the learner's API key as a Bearer token.
 *
 * Only the READ tools are exposed (owner decision): paper discovery, paper
 * reports/full text, PDF questions and a paper's code. Library, follow and
 * metadata tools change the learner's alphaXiv account — never offered.
 *
 * One MCP session per research job: `openAlphaxivTools` connects, lists the
 * server's tools, wraps the allowed ones as agent tools (their JSON-Schema
 * input passes straight through — pi validates plain JSON Schema), and
 * returns a close() the runner calls when the job settles. Tool calls never
 * throw into the agent loop: every failure is a clear error string.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { keyValue } from "../keys.ts";

export const ALPHAXIV_MCP_URL = "https://api.alphaxiv.org/mcp/v1";
export const ALPHAXIV_TOOLS = ["discover_papers", "get_paper_content", "answer_pdf_queries", "read_files_from_github_repository"] as const;
/** Keep the researcher's context sane — long paper texts truncate with a marker. */
const MAX_RESULT_CHARS = 40_000;
const CALL_TIMEOUT_MS = 90_000;

/** The slice of the MCP client this module uses (tests inject a fake). */
export interface McpClientLike {
	listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
	callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: undefined, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
	close(): Promise<void>;
}

export interface ResearchToolSet {
	tools: AgentTool<any>[];
	close(): Promise<void>;
}

/** Flatten an MCP tool result to the text the researcher reads. */
export function mcpResultText(result: unknown): string {
	const r = result as { content?: Array<{ type?: string; text?: string; resource?: { uri?: string; text?: string } }>; structuredContent?: unknown; isError?: boolean } | null;
	const parts: string[] = [];
	for (const item of r?.content ?? []) {
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
		else if (item.type === "resource" && item.resource) parts.push(item.resource.text ?? item.resource.uri ?? "");
	}
	if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
	let text = parts.join("\n\n").trim() || "(empty result)";
	if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Truncated at ${MAX_RESULT_CHARS} characters]`;
	return r?.isError ? `alphaXiv error: ${text}` : text;
}

/** Wrap the allowed tools of a connected client (exported for tests). */
export async function wrapAlphaxivTools(client: McpClientLike): Promise<AgentTool<any>[]> {
	const { tools } = await client.listTools();
	return tools
		.filter((tool) => (ALPHAXIV_TOOLS as readonly string[]).includes(tool.name))
		.map((tool): AgentTool<any> => ({
			name: `alphaxiv_${tool.name}`,
			label: `alphaxiv_${tool.name}`,
			description: `alphaXiv (research papers): ${tool.description ?? tool.name}`,
			parameters: tool.inputSchema as never,
			execute: async (_toolCallId, input, signal) => {
				let text: string;
				try {
					text = mcpResultText(await client.callTool({ name: tool.name, arguments: (input ?? {}) as Record<string, unknown> }, undefined, { signal, timeout: CALL_TIMEOUT_MS }));
				} catch (err) {
					text = `alphaXiv ${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`;
				}
				return { content: [{ type: "text", text }], details: undefined };
			},
		}));
}

/** Connect with the stored key; null when no key is set. A connection
 * failure also yields null — research continues on the web tools alone. */
export async function openAlphaxivTools(apiKey = keyValue("ALPHAXIV_API_KEY")): Promise<ResearchToolSet | null> {
	if (!apiKey) return null;
	const client = new Client({ name: "learnharness", version: "1" });
	try {
		await client.connect(new StreamableHTTPClientTransport(new URL(ALPHAXIV_MCP_URL), {
			requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
		}));
		const tools = await wrapAlphaxivTools(client as unknown as McpClientLike);
		return { tools, close: () => client.close().catch(() => {}) };
	} catch (err) {
		console.error("[alphaxiv] MCP connection failed:", err instanceof Error ? err.message : err);
		await client.close().catch(() => {});
		return null;
	}
}
