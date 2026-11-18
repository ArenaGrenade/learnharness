import { NextResponse, type NextRequest } from "next/server";
import { selfHostedRequestRefusal } from "./src/self-host/request-gate.ts";

export function proxy(request: NextRequest) {
 const denied = selfHostedRequestRefusal(request);
 if (denied) {
  if (denied.status === 401 && !request.nextUrl.pathname.startsWith("/api")) {
   const login = new URL("/login", request.url);
   if (request.nextUrl.pathname !== "/") login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
   return NextResponse.redirect(login);
  }
  return denied;
 }
 if (process.env.LH_AUTH_MODE === "cloudflare-access" && request.nextUrl.pathname === "/login") return NextResponse.redirect(new URL("/", request.url));
 return NextResponse.next();
}

export const config = {
 matcher: ["/((?!_next/static|_next/image|favicon\\.ico|fonts/|manifest\\.webmanifest$|sw\\.js$|icon-192\\.png$|icon-512\\.png$|apple-touch-icon\\.png$|favicon-32\\.png$|api/plugins/[^/]+/documents/markdown/?$).*)"],
};
