/**
 * Tiny pub/sub so the low-level API client (which has no React context) can
 * tell AuthContext "the session is no longer valid" whenever any request
 * comes back 401 — e.g. a session that expired while the dashboard was open
 * in the background. This is what makes an expired session redirect to
 * /login on the next API call instead of the app quietly failing. See
 * /docs/AUTHENTICATION.md "Session lifecycle".
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onUnauthenticated(callback: Listener): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function emitUnauthenticated(): void {
  for (const listener of listeners) listener();
}
