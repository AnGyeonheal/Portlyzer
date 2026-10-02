import { existsSync } from "node:fs";

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const email = process.env.SEED_DEMO_EMAIL;
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error("Set SEED_DEMO_EMAIL and SEED_DEMO_PASSWORD (at least 12 characters), or use the isolated demo button in the app.");
  }
  const { auth } = await import("../src/lib/auth");
  const { db } = await import("../src/lib/db");
  const { seedDemoUser } = await import("../src/lib/services/demo");
  try {
    let user = await db.user.findUnique({ where: { email } });
    if (user && !user.isDemo) throw new Error("Refusing to seed a real user.");
    if (!user) {
      const result = await auth.api.signUpEmail({ body: { email, password, name: "데모 투자자" } });
      user = await db.user.update({ where: { id: result.user.id }, data: { isDemo: true } });
    }
    const result = await seedDemoUser(user.id);
    console.info(result.alreadySeeded ? "Demo already initialized; existing data preserved." : "Isolated demo initialized.");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo seed failed.");
  process.exitCode = 1;
});
