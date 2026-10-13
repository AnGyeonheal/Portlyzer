import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, downloadFile, request } from "@/components/portfolio/api";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("JSON and file requests", () => {
  it("preserves authenticated JSON requests and error messages", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ value: "exact" }))
      .mockResolvedValueOnce(Response.json({ error: { code: "NOT_FOUND", message: "계좌를 찾을 수 없습니다." } }, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(request("/api/test", { method: "POST", body: "{}" })).resolves.toEqual({ value: "exact" });
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", headers: { "Content-Type": "application/json" } });
    await expect(request("/api/test")).rejects.toMatchObject({ code: "NOT_FOUND", message: "계좌를 찾을 수 없습니다." });
  });

  it("lets the browser set multipart boundaries", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ uploaded: true }));
    vi.stubGlobal("fetch", fetch);
    await request("/api/upload", { method: "POST", body: new FormData() });
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("Content-Type");
  });

  it("reports network and authentication failures instead of downloading an error page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json({ error: { code: "UNAUTHORIZED", message: "로그인이 필요합니다." } }, { status: 401 })));
    await expect(downloadFile("/api/template", "file.xlsx", "application/x-test")).rejects.toBeInstanceOf(ApiError);
    await expect(downloadFile("/api/template", "file.xlsx", "application/x-test")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects successful responses with the wrong MIME type or empty content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ wrong: true }))
      .mockResolvedValueOnce(new Response(null, { headers: { "Content-Type": "application/x-test" } })));
    await expect(downloadFile("/api/template", "file.xlsx", "application/x-test")).rejects.toMatchObject({ code: "DOWNLOAD_FORMAT" });
    await expect(downloadFile("/api/template", "file.xlsx", "application/x-test")).rejects.toMatchObject({ code: "EMPTY_DOWNLOAD" });
  });

  it("reports interrupted binary transfers", async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error("connection closed")); } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "Content-Type": "application/x-test" } })));
    await expect(downloadFile("/api/template", "file.xlsx", "application/x-test")).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  });

  it("downloads the binary and releases its object URL", async () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([80, 75]), { headers: { "Content-Type": "application/x-test" } })));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:template-test");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await downloadFile("/api/template", "file.xlsx", "application/x-test");
    expect(create).toHaveBeenCalled();
    expect(anchor).toMatchObject({ href: "blob:template-test", download: "file.xlsx" });
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:template-test");
  });
});
