import { describe, expect, it } from "vitest";
import { checkOrigin, readBoundedBody, readJson } from "@/lib/server";
import { AppError } from "@/lib/errors";

describe("request boundaries", () => {
  it("rejects unknown and missing origins on cookie-authenticated writes", () => {
    expect(() => checkOrigin(new Request("http://127.0.0.1:3100/api/accounts", { method: "POST" }))).toThrow(AppError);
    expect(() => checkOrigin(new Request("http://127.0.0.1:3100/api/accounts", { method: "POST", headers: { origin: "https://untrusted.invalid" } }))).toThrow(AppError);
    expect(() => checkOrigin(new Request("http://127.0.0.1:3100/api/accounts", { method: "GET" }))).not.toThrow();
  });

  it("enforces the actual streamed body size even without Content-Length", async () => {
    const request = new Request("http://localhost/", { method: "POST", body: "12345" });
    await expect(readBoundedBody(request, 4)).rejects.toMatchObject({ code: "UPLOAD_SIZE", status: 413 });
  });

  it("surfaces malformed JSON and unsupported content type explicitly", async () => {
    await expect(readJson(new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })))
      .rejects.toMatchObject({ code: "INVALID_JSON" });
    await expect(readJson(new Request("http://localhost/", { method: "POST", body: "{}" })))
      .rejects.toMatchObject({ code: "CONTENT_TYPE" });
  });
});
