import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/** Thin Promise wrapper — `util.promisify`'s overload resolution for `scrypt`'s optional-options signature is unreliable in TS, so this is written out directly instead. */
function scrypt(password: string, salt: Buffer, keylen: number, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { cost }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing via Node's built-in `crypto.scrypt` — a vetted,
 * memory-hard KDF (RFC 7914), not a hand-rolled algorithm, and not a new
 * dependency (avoids the native-build risk of bcrypt/argon2 packages while
 * still meeting OWASP's password-storage guidance). See
 * /docs/TECHNICAL_DECISIONS.md for why this was chosen over an npm package.
 *
 * Parameters follow Node's own documented recommendation (N=16384 i.e.
 * `cost: 2**14`, keylen 64) — deliberately not configurable per call, so
 * every password in this system is hashed the same way.
 */
const SCRYPT_COST = 16384; // N
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** Format: scrypt$<saltHex>$<hashHex> — self-describing so the algorithm/params could change later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_COST);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Constant-time comparison (via `timingSafeEqual`) so verification time doesn't leak how much of the hash matched. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const derived = await scrypt(password, salt, expected.length, SCRYPT_COST);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
