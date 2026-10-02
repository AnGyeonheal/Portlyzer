import { auth } from "./auth";
import { db } from "./db";
import { AppError } from "./errors";

export async function requireUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AppError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (!user) throw new AppError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
  return user;
}

export function checkOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.BETTER_AUTH_URL ?? request.url).origin;
  if (!origin || origin !== expected) {
    throw new AppError(403, "ORIGIN", "허용되지 않은 요청 출처입니다.");
  }
}

export async function rateLimit(userId: string, operation: string, maximum = 120) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${userId}:${operation}:${minute}`;
  const row = await db.apiRateLimit.upsert({
    where: { key },
    create: { key, count: 1, windowStart: new Date(minute * 60000) },
    update: { count: { increment: 1 } },
  });
  if (row.count > maximum) throw new AppError(429, "RATE_LIMIT", "요청이 많습니다. 1분 후 다시 시도해 주세요.");
}

export async function readJson(request: Request, limit = 1024 * 1024): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new AppError(415, "CONTENT_TYPE", "JSON 형식이 필요합니다.");
  }
  const bytes = await readBoundedBody(request, limit);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) throw new AppError(400, "INVALID_JSON", "JSON 형식이 올바르지 않습니다.");
    throw error;
  }
}

export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > limit) throw new AppError(413, "UPLOAD_SIZE", "파일 또는 요청 크기 제한을 초과했습니다.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "EMPTY_BODY", "요청 내용이 없습니다.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError(413, "UPLOAD_SIZE", "파일 또는 요청 크기 제한을 초과했습니다.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
