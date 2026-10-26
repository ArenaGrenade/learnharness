/** POST — send a test notification to every subscribed device. */
import { sendPush } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	return Response.json(await sendPush({ title: "LearnHarness", body: "Notifications work on this device.", url: "/", tag: "test" }));
}
