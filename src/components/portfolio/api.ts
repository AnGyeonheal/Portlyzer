"use client";

import { useState } from "react";

export class ApiError extends Error {
  constructor(message: string, public code: string, public details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchResponse(url: string, options: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("서버에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.", "NETWORK_ERROR");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.error?.message || (response.status === 401 ? "로그인이 만료되었습니다. 다시 로그인해 주세요." : "요청을 처리하지 못했습니다. 다시 시도해 주세요."), body?.error?.code || String(response.status), body?.error?.details);
  }
  return response;
}

export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetchResponse(url, options);
  return await response.json().catch(() => null) as T;
}

export async function downloadFile(url: string, filename: string, mimeType: string): Promise<void> {
  const response = await fetchResponse(url);
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== mimeType.toLowerCase()) {
    throw new ApiError("다운로드 응답이 올바른 파일 형식이 아닙니다. 다시 시도해 주세요.", "DOWNLOAD_FORMAT");
  }
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new ApiError("파일을 끝까지 내려받지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.", "DOWNLOAD_FAILED");
  }
  if (!blob.size) throw new ApiError("다운로드한 파일이 비어 있습니다. 다시 시도해 주세요.", "EMPTY_DOWNLOAD");
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return "알 수 없는 오류가 발생했습니다. 다시 시도해 주세요.";
  if (error instanceof ApiError && error.details) {
    const details = error.details;
    const lines: string[] = [];
    if (Array.isArray(details)) {
      for (const detail of details.slice(0, 5)) {
        if (detail && typeof detail === "object" && "message" in detail) lines.push(String(detail.message));
      }
    } else if (typeof details === "object" && "fieldErrors" in details) {
      const fields = (details as { fieldErrors: Record<string, unknown> }).fieldErrors;
      for (const [field, messages] of Object.entries(fields ?? {})) lines.push(`${field}: ${Array.isArray(messages) ? messages.join(", ") : String(messages)}`);
    }
    return lines.length ? `${error.message} ${lines.join(" · ")}` : error.message;
  }
  return error.message;
}

export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(operation: () => Promise<T>, onSuccess?: (result: T) => void): Promise<T | undefined> {
    setPending(true);
    setError(null);
    try {
      const result = await operation();
      onSuccess?.(result);
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return undefined;
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run, setError };
}
