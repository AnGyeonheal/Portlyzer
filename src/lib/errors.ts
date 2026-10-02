import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { FinanceValidationError } from "./finance";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return Response.json({ error: { code: "VALIDATION", message: "입력값을 확인해 주세요.", details: error.issues } }, { status: 422 });
  }
  if (error instanceof FinanceValidationError) {
    return Response.json({ error: { code: "FINANCIAL_VALIDATION", message: "계산에 필요한 원장과 가정값을 확인해 주세요.", details: error.issues } }, { status: 422 });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return Response.json({ error: { code: "DUPLICATE", message: "이미 등록된 데이터입니다." } }, { status: 409 });
    if (error.code === "P2034") return Response.json({ error: { code: "CONCURRENT_UPDATE", message: "동시에 변경된 데이터가 있습니다. 새로고침 후 다시 시도해 주세요." } }, { status: 409 });
    if (error.code === "P2025") return Response.json({ error: { code: "NOT_FOUND", message: "데이터를 찾을 수 없습니다." } }, { status: 404 });
  }
  const incidentId = crypto.randomUUID();
  console.error(JSON.stringify({ event: "server_error", incidentId, type: error instanceof Error ? error.name : "UnknownError" }));
  return Response.json({ error: { code: "INTERNAL", message: "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.", incidentId } }, { status: 500 });
}
