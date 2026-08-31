import { describe, expect, it, vi, beforeEach } from "vitest";
import { apiClient } from "./client.js";
import { ApiError, NetworkError } from "./errors.js";
import { onUnauthenticated } from "../auth/auth-events.js";

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      ...response,
    }),
  );
}

describe("apiClient", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("parses a successful JSON response", async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({ hello: "world" }) });
    const result = await apiClient.get<{ hello: string }>("/anything");
    expect(result).toEqual({ hello: "world" });
  });

  it("throws ApiError with the server's error code/message on a non-2xx response", async () => {
    mockFetch({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "NOT_FOUND", message: "Task not found: x" } }),
    });
    await expect(apiClient.get("/tasks/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "NOT_FOUND",
      message: "Task not found: x",
    });
  });

  it("throws NetworkError when fetch itself rejects (offline/unreachable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(apiClient.get("/projects")).rejects.toBeInstanceOf(NetworkError);
  });

  it("never leaks a raw error for a non-JSON error response", async () => {
    mockFetch({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });
    const error = await apiClient.get("/projects").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).not.toMatch(/not json/);
  });

  it("emits an unauthenticated event on a 401 from a protected route, so an expired session is noticed", async () => {
    mockFetch({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } }) });
    const listener = vi.fn();
    const unsubscribe = onUnauthenticated(listener);
    await apiClient.get("/projects").catch(() => {});
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not emit unauthenticated for a 401 from /auth/* itself (e.g. a failed login)", async () => {
    mockFetch({ ok: false, status: 401, json: async () => ({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } }) });
    const listener = vi.fn();
    const unsubscribe = onUnauthenticated(listener);
    await apiClient.post("/auth/login", { email: "a@b.com", password: "x" }).catch(() => {});
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
