import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { checkOrigin, readBoundedBody, readJson } from "@/lib/server";
import { errorResponse } from "@/lib/errors";
import { z } from "zod";
import { requireMailDelivery } from "@/lib/mail";

export const runtime = "nodejs";
const handlers = toNextJsHandler(auth);
export const GET = handlers.GET;

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const body = request.body ? await readBoundedBody(request, 16384) : undefined;
    if (new URL(request.url).pathname === "/api/auth/delete-user") {
      const input = await readJson(new Request(request.url, { method: "POST", headers: request.headers, body: body?.buffer }), 16384);
      z.object({ password: z.string().min(12).max(128) }).parse(input);
    }
    return await requireMailDelivery(() => handlers.POST(new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: body?.buffer,
    })));
  } catch (error) {
    return errorResponse(error);
  }
}
