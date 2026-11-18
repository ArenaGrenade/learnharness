/** Web deployment boot; shared source remains compatible with upstream. */
export async function register() {
 if (process.env.NEXT_RUNTIME === "nodejs") {
  const { bootSelfHostedApp } = await import("./src/self-host/boot.ts");
  await bootSelfHostedApp();
 }
}
