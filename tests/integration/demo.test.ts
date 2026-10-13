import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { seedDemoUser } from "@/lib/services/demo";
import { getWorkspace } from "@/lib/services/workspace";
import { dateOf, shiftDay } from "@/lib/input";

const suite = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

suite("complete and isolated demo history", () => {
  const users: string[] = [];

  async function createUser(isDemo = true) {
    const id = randomUUID();
    users.push(id);
    await db.user.create({ data: { id, name: "Demo coverage fixture", email: `${id}@example.invalid`, isDemo } });
    return id;
  }

  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  it.each(["2026-10-02", "2026-01-03"])("covers the default year and one-year comparison on %s", async (end) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${end}T12:00:00Z`));
    const userId = await createUser();
    await seedDemoUser(userId);
    for (const from of [`${end.slice(0, 4)}-01-01`, shiftDay(end, -365)]) {
      const data = await getWorkspace(userId, { from, to: end });
      expect(data.analysis.issues.filter((issue) => issue.severity === "error").length).toBe(0);
      expect(data.analysis.summary.totalValue).not.toBeNull();
      expect(data.analysis.benchmark?.returnRate).not.toBeNull();
      expect(data.analysis.provenance.every((row) => row.source === "DEMO")).toBe(true);
    }
  });

  it("repairs an older demo's missing history without overwriting observations or ledger records", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const userId = await createUser();
    await seedDemoUser(userId);
    const ledger = await db.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const original = await db.price.findFirstOrThrow({ where: { userId, date: dateOf("2026-10-02") } });
    await db.price.update({ where: { id: original.id }, data: { close: "123" } });
    await db.price.deleteMany({ where: { userId, date: { lt: dateOf(shiftDay("2026-10-02", -180)) } } });
    await db.fxRate.deleteMany({ where: { userId, date: { lt: dateOf(shiftDay("2026-10-02", -180)) } } });
    await expect(seedDemoUser(userId)).resolves.toMatchObject({ alreadySeeded: true });
    expect(await db.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } })).toEqual(ledger);
    expect((await db.price.findUniqueOrThrow({ where: { id: original.id } })).close.toString()).toBe("123");
    const data = await getWorkspace(userId, { from: "2026-01-01", to: "2026-10-02" });
    expect(data.analysis.issues.filter((issue) => issue.severity === "error").length).toBe(0);
  });

  it("never creates or repairs synthetic records for a real user", async () => {
    const userId = await createUser(false);
    await expect(seedDemoUser(userId)).rejects.toMatchObject({ code: "DEMO_ISOLATION" });
    expect(await db.price.count({ where: { userId } })).toBe(0);
    expect(await db.transaction.count({ where: { userId } })).toBe(0);
  });
});
