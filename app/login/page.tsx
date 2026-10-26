import { readAccess } from "@/src/server";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

/** Outside the (app) group: no event channel or settings reads before a session. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
	const { next } = await searchParams;
	// Only same-app paths: never an absolute or protocol-relative redirect.
	const target = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-4 font-ui text-foreground">
			<LoginForm next={target} configured={readAccess() !== null} />
		</main>
	);
}
