/** Mirrors the error envelope documented in /docs/API.md "Error format". */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** The server's `error.details` (present for INVALID_REQUEST — Zod's `flatten()` shape), if any — see /docs/API.md "Error format". */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A request never reached the server (offline, backend down, etc.) — distinct from a server-returned error. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("Could not reach the server. Check your connection and try again.");
    this.name = "NetworkError";
    this.cause = cause;
  }
}
