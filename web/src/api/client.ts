import { ApiError, NetworkError, type ApiErrorBody } from "./errors.js";
import { emitUnauthenticated } from "../auth/auth-events.js";

/**
 * The only place fetch() is called from. Every typed API module (auth,
 * projects, tasks, humanInput) goes through this — see
 * /docs/UI_ARCHITECTURE.md "API integration" for why calls are never
 * scattered directly into components.
 *
 * Identity is carried entirely by the session cookie the backend sets on
 * login/register (HttpOnly — this code never reads or stores it). `fetch`'s
 * default credentials mode already sends same-origin cookies, but this is
 * explicit for clarity. See /docs/AUTHENTICATION.md.
 */
const BASE_URL = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (err) {
    throw new NetworkError(err);
  }

  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // response wasn't JSON — fall through to a generic message
    }
    // Skip /auth/* itself — a failed login attempt is not "the session expired," and emitting
    // here would be a same-tick no-op loop with AuthContext's own handling of that response.
    if (res.status === 401 && !path.startsWith("/auth/")) {
      emitUnauthenticated();
    }
    throw new ApiError(res.status, body?.error?.code ?? "UNKNOWN", body?.error?.message ?? `Request failed (${res.status})`, body?.error?.details);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) => request<T>(path, { method: "POST", body: JSON.stringify(body), headers }),
  put: <T>(path: string, body: unknown, headers?: Record<string, string>) => request<T>(path, { method: "PUT", body: JSON.stringify(body), headers }),
  patch: <T>(path: string, body: unknown, headers?: Record<string, string>) => request<T>(path, { method: "PATCH", body: JSON.stringify(body), headers }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  /**
   * Phase 4D.7 — upload raw binary bytes (e.g. images, large files) as application/octet-stream.
   * File metadata is sent in custom headers; returns an `attachmentId` the client references
   * in the subsequent chat message POST.
   */
  postBinary: <T>(path: string, data: ArrayBuffer, meta: { filename: string; mimeType: string }) => {
    let res: globalThis.Response;
    return fetch(`${BASE_URL}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/octet-stream",
        "x-attachment-filename": meta.filename,
        "x-attachment-mime-type": meta.mimeType,
      },
      body: data,
    })
      .catch((err) => { throw new NetworkError(err); })
      .then((r) => { res = r; return r; })
      .then(async (r) => {
        if (!r.ok) {
          let body: ApiErrorBody | null = null;
          try { body = (await r.json()) as ApiErrorBody; } catch {}
          if (r.status === 401) emitUnauthenticated();
          throw new ApiError(r.status, body?.error?.code ?? "UNKNOWN", body?.error?.message ?? `Request failed (${r.status})`, body?.error?.details);
        }
        return (await r.json()) as T;
      });
  },
};
