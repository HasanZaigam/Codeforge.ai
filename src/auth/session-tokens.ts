import { createHash, randomBytes } from "node:crypto";

/**
 * Session tokens are opaque, high-entropy random values looked up
 * server-side on every request — not self-verifying tokens like a signed
 * JWT. That's deliberate: nothing here needs a signing secret at all (see
 * /docs/AUTHENTICATION.md and TECHNICAL_DECISIONS.md for why that's a
 * simpler and equally secure choice for this MVP), and revocation (logout)
 * is a plain database delete instead of needing a blocklist.
 *
 * The raw token is what's sent to the browser (in the session cookie); only
 * its hash is ever persisted, the same "don't store the secret itself"
 * principle as password hashing — a stolen database backup doesn't hand out
 * usable sessions. SHA-256 (not scrypt) is appropriate here because the
 * token is already high-entropy random data, not a human-chosen secret an
 * attacker could feasibly guess and hash-check — the slow KDF that matters
 * for passwords isn't needed for an unguessable 256-bit value.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
