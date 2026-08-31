/**
 * Test-only helper: registers a fresh user against a running test server and
 * returns a `fetch` wrapper that carries the resulting session cookie, so
 * HTTP-layer tests exercise the real authentication flow (register -> cookie
 * -> authenticated requests) instead of the old trusted-header shortcut.
 * Not picked up by the `tests/**\/*.test.ts` glob — no `.test.ts` suffix.
 */
export interface AuthedClient {
  baseUrl: string;
  userId: string;
  email: string;
  /** Same signature as global fetch, with the session cookie already attached. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

let counter = 0;

export async function registerClient(baseUrl: string, label: string): Promise<AuthedClient> {
  const email = `${label}-${++counter}@example.com`;
  const password = "correct horse battery staple";
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: `Tester ${label}` }),
  });
  if (res.status !== 201) {
    throw new Error(`registerClient(${label}) failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("registerClient: no session cookie in response");
  const cookie = setCookie.split(";")[0]!;
  const { user } = (await res.json()) as { user: { id: string } };

  const doFetch = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", cookie, ...init.headers } });

  return { baseUrl, userId: user.id, email, fetch: doFetch };
}
