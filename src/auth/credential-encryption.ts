import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts third-party integration secrets (currently: GitHub tokens) at
 * rest — AES-256-GCM (authenticated encryption: tampering with the
 * ciphertext is detected, not just silently decrypted wrong). See
 * /docs/GITHUB_INTEGRATION.md "Credential storage" and
 * /docs/TECHNICAL_DECISIONS.md for why this exists as a distinct concern
 * from password hashing (TD-31) — a password is verified, never recovered;
 * a GitHub token must be recovered in full to call the GitHub API with it,
 * so it's encrypted, not hashed.
 */
export interface EncryptedSecret {
  ciphertext: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // recommended IV length for GCM

export class CredentialEncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialEncryptionKeyError";
  }
}

/**
 * Reads and validates `CREDENTIAL_ENCRYPTION_KEY` from the environment —
 * called lazily, only when a credential is actually stored/read, so a
 * deployment that never uses the GitHub integration never needs this set.
 * Expects a base64-encoded 32-byte key. Never logged, never has a default —
 * an unset or malformed key fails loudly rather than silently using a weak
 * or predictable key.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new CredentialEncryptionKeyError(
      "CREDENTIAL_ENCRYPTION_KEY is required to store or read GitHub credentials. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` and set it in your environment.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CredentialEncryptionKeyError(`CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}).`);
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("hex"), iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(secret.iv, "hex"));
  decipher.setAuthTag(Buffer.from(secret.authTag, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "hex")), decipher.final()]);
  return plaintext.toString("utf-8");
}
