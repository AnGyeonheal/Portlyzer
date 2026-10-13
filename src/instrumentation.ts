export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runtimeConfig } = await import("./lib/environment");
    runtimeConfig();
  }
}
