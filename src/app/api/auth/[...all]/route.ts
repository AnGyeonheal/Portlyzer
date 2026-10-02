import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { readBoundedBody } from "@/lib/server";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
const handlers = toNextJsHandler(auth);
export const GET = handlers.GET;

export async function POST(request: Request) {
  try {
    const body = request.body ? await readBoundedBody(request, 16384) : undefined;
    return await handlers.POST(new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: body?.buffer,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
