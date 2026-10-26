/** GET /api/connections/chatgpt/usage — live plan usage for the active
 *  ChatGPT account ({available, windows…} or {available:false, reason}),
 *  cached server-side for two minutes (ChatGPT throttles frequent reads). */
import { chatGPTUsage } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ usage: await chatGPTUsage() }, { headers: { "Cache-Control": "no-store" } });
}
