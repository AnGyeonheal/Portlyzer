import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { checkOrigin, rateLimit, readBoundedBody, readJson, requireUser } from "@/lib/server";
import { getWorkspace } from "@/lib/services/workspace";
import {
  deleteAccount, deleteDividend, deleteGoal, deletePortfolio, deleteTarget,
  saveAccount, saveAsset, saveDividend, saveGoal, savePortfolio, saveSettings, saveTarget,
} from "@/lib/services/entities";
import { createTransaction, deleteTransaction, getTransactionHistory, updateTransaction } from "@/lib/services/ledger";
import { confirmImport, uploadImport, validateImport } from "@/lib/services/imports";
import { importManualFx, importManualPrices, refreshMarketData, upsertManualFx, upsertManualPrice } from "@/lib/services/market";
import { seedDemoUser } from "@/lib/services/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const revisionInput = z.object({ revision: z.number().int().positive() }).strict();
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function createDemo(request: Request) {
  if (process.env.ENABLE_DEMO !== "true") throw new AppError(403, "DEMO_DISABLED", "이 환경에서는 데모가 비활성화되어 있습니다.");
  await rateLimit("anonymous", "demo", 5);
  const suffix = crypto.randomUUID();
  const result = await auth.api.signUpEmail({
    body: { name: "데모 투자자", email: `demo-${suffix}@example.invalid`, password: `${crypto.randomUUID()}${crypto.randomUUID()}` },
    headers: request.headers, asResponse: true,
  });
  if (!result.ok) return result;
  const session: unknown = await result.clone().json();
  const parsed = z.object({ user: z.object({ id: z.string() }) }).parse(session);
  await db.user.update({ where: { id: parsed.user.id }, data: { isDemo: true } });
  await seedDemoUser(parsed.user.id);
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const cookie of result.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ demo: true }), { headers });
}

async function exportUser(userId: string) {
  const data = await db.$transaction(async (tx) => {
    const [user, accounts, portfolios, assets, transactions, originals, revisions, journal, prices, fx,
      dividends, corporateActions, imports, goals, targets] = await Promise.all([
      tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, baseCurrency: true, costMethod: true, benchmarkAssetId: true, isDemo: true } }),
      tx.brokerAccount.findMany({ where: { userId } }),
      tx.portfolio.findMany({ where: { userId } }),
      tx.asset.findMany({ where: { userId } }),
      tx.transaction.findMany({ where: { userId } }),
      tx.originalTransaction.findMany({ where: { userId } }),
      tx.transactionRevision.findMany({ where: { userId } }),
      tx.journalEntry.findMany({ where: { userId } }),
      tx.price.findMany({ where: { userId } }),
      tx.fxRate.findMany({ where: { userId } }),
      tx.dividendEvent.findMany({ where: { userId } }),
      tx.corporateAction.findMany({ where: { userId } }),
      tx.importJob.findMany({ where: { userId } }),
      tx.investmentGoal.findMany({ where: { userId } }),
      tx.allocationTarget.findMany({ where: { userId } }),
    ]);
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), user, accounts, portfolios, assets,
      transactions, originals, revisions, journal, prices, fx, dividends, corporateActions, imports, goals, targets };
  }, { isolationLevel: "RepeatableRead", timeout: 30000 });
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="portlyzer-export.json"', "Cache-Control": "no-store" },
  });
}

async function handler(request: Request, context: Context): Promise<Response> {
  try {
    const { path } = await context.params;
    const [resource, id, action] = path;
    const method = request.method;
    if (path.length > 3) throw new AppError(404, "NOT_FOUND", "요청 경로를 찾을 수 없습니다.");
    checkOrigin(request);
    if (resource === "health" && path.length === 1 && method === "GET") {
      await db.$queryRaw`SELECT 1`;
      return json({ status: "ok" });
    }
    if (resource === "demo" && path.length === 1 && method === "POST") return await createDemo(request);
    const user = await requireUser(request);
    await rateLimit(user.id, method === "GET" ? "read" : "write", method === "GET" ? 180 : 60);
    if (method === "GET") {
      if (resource === "workspace" && path.length === 1) return json(await getWorkspace(user.id, Object.fromEntries(new URL(request.url).searchParams)));
      if (resource === "export" && path.length === 1) return await exportUser(user.id);
      if (resource === "transactions" && id && action === "history") return json(await getTransactionHistory(user.id, id));
    }
    if (resource === "imports" && id === "upload" && !action && method === "POST") {
      await rateLimit(user.id, "upload", 10);
      const contentType = request.headers.get("content-type");
      if (!contentType?.startsWith("multipart/form-data;")) throw new AppError(415, "CONTENT_TYPE", "파일 업로드 형식이 필요합니다.");
      const bytes = await readBoundedBody(request, 2 * 1024 * 1024 + 65536);
      let form: FormData;
      try {
        form = await new Response(bytes.buffer, { headers: { "Content-Type": contentType } }).formData();
      } catch (error) {
        if (error instanceof TypeError) throw new AppError(400, "INVALID_MULTIPART", "업로드 요청 형식이 올바르지 않습니다.");
        throw error;
      }
      const file = form.get("file");
      const accountId = form.get("accountId");
      if (!(file instanceof File) || typeof accountId !== "string" || form.getAll("file").length !== 1) {
        throw new AppError(422, "UPLOAD_FIELDS", "파일 하나와 계좌를 선택하세요.");
      }
      return json(await uploadImport(user.id, accountId, file.name, new Uint8Array(await file.arrayBuffer())), 201);
    }
    if (resource === "imports" && id && action === "validate" && method === "POST") {
      const input = z.object({
        revision: z.number().int().positive(),
        mapping: z.record(z.string(), z.string().max(200)),
        changes: z.record(z.string(), z.record(z.string(), z.string().max(1000))).optional(),
        decisions: z.record(z.string(), z.enum(["KEEP", "SKIP"])).optional(),
      }).strict().parse(await readJson(request, 2 * 1024 * 1024));
      return json(await validateImport(user.id, id, input));
    }
    if (resource === "imports" && id && action === "confirm" && method === "POST") {
      const { revision } = revisionInput.parse(await readJson(request));
      return json(await confirmImport(user.id, id, revision));
    }
    if (action) throw new AppError(404, "NOT_FOUND", "요청 경로를 찾을 수 없습니다.");
    if (method === "POST" || method === "PATCH") {
      const input = await readJson(request);
      if (resource === "transactions") {
        if (method === "POST" && !id) {
          const requestId = request.headers.get("idempotency-key") ?? undefined;
          if (requestId && !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new AppError(422, "IDEMPOTENCY_KEY", "요청 식별자가 올바르지 않습니다.");
          return json(await createTransaction(user.id, input, requestId), 201);
        }
        if (method === "PATCH" && id) return json(await updateTransaction(user.id, id, input));
      }
      const validSave = (method === "POST" && !id) || (method === "PATCH" && !!id);
      if (validSave) {
        if (resource === "accounts") return json(await saveAccount(user.id, input, id), id ? 200 : 201);
        if (resource === "portfolios") return json(await savePortfolio(user.id, input, id), id ? 200 : 201);
        if (resource === "assets") return json(await saveAsset(user.id, input, id), id ? 200 : 201);
        if (resource === "goals") return json(await saveGoal(user.id, input, id), id ? 200 : 201);
        if (resource === "dividends") return json(await saveDividend(user.id, input, id), id ? 200 : 201);
      }
      if (resource === "settings" && !id) return json(await saveSettings(user.id, input));
      if (resource === "targets" && !id && method === "POST") return json(await saveTarget(user.id, input));
      if (resource === "prices" && !id && method === "POST") return json(await upsertManualPrice(user.id, input));
      if (resource === "prices" && id === "import" && method === "POST") return json(await importManualPrices(user.id, input));
      if (resource === "fx" && !id && method === "POST") return json(await upsertManualFx(user.id, input));
      if (resource === "fx" && id === "import" && method === "POST") return json(await importManualFx(user.id, input));
      if (resource === "refresh" && !id && method === "POST") return json(await refreshMarketData(user.id, input));
    }
    if (method === "DELETE" && id) {
      if (resource === "transactions") {
        const { revision } = revisionInput.parse(await readJson(request));
        await deleteTransaction(user.id, id, revision);
      } else if (resource === "accounts") await deleteAccount(user.id, id);
      else if (resource === "portfolios") await deletePortfolio(user.id, id);
      else if (resource === "goals") await deleteGoal(user.id, id);
      else if (resource === "dividends") await deleteDividend(user.id, id);
      else if (resource === "targets") await deleteTarget(user.id, id);
      else throw new AppError(404, "NOT_FOUND", "요청 경로를 찾을 수 없습니다.");
      return json({ deleted: true });
    }
    throw new AppError(404, "NOT_FOUND", "요청 경로 또는 메서드를 찾을 수 없습니다.");
  } catch (error) {
    return errorResponse(error);
  }
}

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
