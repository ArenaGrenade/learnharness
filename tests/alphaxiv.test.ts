/** alphaXiv MCP tools for the researcher (src/server/mcp/alphaxiv.ts) — a fake client, no network. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALPHAXIV_TOOLS, mcpResultText, openAlphaxivTools, wrapAlphaxivTools, type McpClientLike } from "../src/server/mcp/alphaxiv.ts";

const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
function fakeClient(handler: (name: string, args: unknown) => unknown): McpClientLike & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async listTools() {
			return { tools: ["discover_papers", "get_paper_content", "answer_pdf_queries", "read_files_from_github_repository", "save_papers_to_folder", "follow_researcher", "delete_folder"].map((name) => ({ name, description: `does ${name}`, inputSchema: schema })) };
		},
		async callTool(params) { calls.push(params.name); return handler(params.name, params.arguments); },
		async close() {},
	};
}

describe("alphaXiv tool wrapping", () => {
	it("exposes exactly the four read tools, prefixed, with their JSON Schema", async () => {
		const tools = await wrapAlphaxivTools(fakeClient(() => ({ content: [] })));
		assert.deepEqual(tools.map((t) => t.name), ALPHAXIV_TOOLS.map((n) => `alphaxiv_${n}`));
		assert.deepEqual(tools[0]!.parameters, schema);
		assert.match(tools[0]!.description, /^alphaXiv \(research papers\): does discover_papers/);
	});

	it("returns text content, marks tool errors, and never throws into the loop", async () => {
		const client = fakeClient((name) => {
			if (name === "discover_papers") return { content: [{ type: "text", text: "1706.03762 Attention Is All You Need" }] };
			if (name === "get_paper_content") return { content: [{ type: "text", text: "no such paper" }], isError: true };
			throw new Error("socket hang up");
		});
		const tools = await wrapAlphaxivTools(client);
		const run = async (i: number) => ((await tools[i]!.execute("call", { query: "attention" }, undefined as never)) as { content: { text: string }[] }).content[0]!.text;
		assert.equal(await run(0), "1706.03762 Attention Is All You Need");
		assert.equal(await run(1), "alphaXiv error: no such paper");
		assert.equal(await run(2), "alphaXiv answer_pdf_queries failed: socket hang up");
		assert.deepEqual(client.calls, ["discover_papers", "get_paper_content", "answer_pdf_queries"]);
	});

	it("flattens structured and long results", () => {
		assert.equal(mcpResultText({ content: [], structuredContent: { ids: ["a"] } }), '{\n  "ids": [\n    "a"\n  ]\n}');
		assert.match(mcpResultText({ content: [{ type: "text", text: "x".repeat(50_000) }] }), /\[Truncated at 40000 characters\]$/);
		assert.equal(mcpResultText(null), "(empty result)");
	});

	it("no key = no tools, without any connection attempt", async () => {
		assert.equal(await openAlphaxivTools(""), null);
	});
});
