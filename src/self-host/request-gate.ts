import { apiRequestRefusal, browserOnlyMode } from "../server/desktop-access.ts";
import { readAccess, sameOriginRequest, sessionValid, SESSION_COOKIE } from "./access.ts";

/** Shared by Proxy and streaming document handlers, before reading bodies. */
export function selfHostedRequestRefusal(request: Request): Response | undefined {
	const headers = { "Cache-Control": "no-store" };
	if (!browserOnlyMode()) {
        if (!new URL(request.url).pathname.startsWith("/api/")) return;
		const desktopRefusal = apiRequestRefusal(request);
		return desktopRefusal ? Response.json({ error: desktopRefusal }, { status: 403, headers }) : undefined;
	}
	if (!sameOriginRequest(request.method, request.headers)) return Response.json({ error: "Cross-site request refused." }, { status: 403, headers });
	const policy = apiRequestRefusal(request);
	if (policy) return Response.json({ error: policy }, { status: 403, headers });
	const pathname = new URL(request.url).pathname;
	if (pathname === "/login" || pathname === "/api/auth/login") return;
	if (process.env.LH_AUTH_MODE === "cloudflare-access") return;
	const cookie = request.headers.get("cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
	if (sessionValid(readAccess(), cookie)) return;
	return Response.json({ error: "Sign in to LearnHarness first." }, { status: 401, headers });
}
