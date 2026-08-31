import { randomUUID } from "node:crypto";
import type { User } from "../domain/types.js";
import type { UserRepository } from "../persistence/repositories/user-repository.js";
import type { SessionRepository } from "../persistence/repositories/session-repository.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { generateSessionToken, hashSessionToken, SESSION_TTL_MS } from "../auth/session-tokens.js";
import { EmailAlreadyRegisteredError, InvalidCredentialsError } from "./errors.js";

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthResult {
  user: User;
  /** The raw, one-time session token — the caller (API layer) sets this as the session cookie value; never persisted or logged as-is. */
  token: string;
}

/**
 * The only place authentication logic lives — see /docs/AUTHENTICATION.md.
 * Everything below `register`/`login`/`logout` is plain domain reasoning
 * with no knowledge of HTTP, cookies, or headers; the API layer (src/api/)
 * is what turns a `token` into a `Set-Cookie` header and a cookie back into
 * a call to `resolveSession`.
 */
export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
  ) {}

  async register(input: RegisterInput): Promise<AuthResult> {
    if (this.users.findByEmail(input.email)) {
      throw new EmailAlreadyRegisteredError();
    }
    const now = new Date().toISOString();
    const user: User = {
      id: randomUUID(),
      tenantId: "default",
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      createdAt: now,
    };
    this.users.insert(user);
    return { user, token: this.issueSession(user.id) };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = this.users.findByEmail(input.email);
    // Same error, same shape, whether the email doesn't exist or the password is wrong — see
    // InvalidCredentialsError's own doc comment on why these two cases must not be distinguishable.
    if (!user) throw new InvalidCredentialsError();
    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) throw new InvalidCredentialsError();
    return { user, token: this.issueSession(user.id) };
  }

  /** Server-side revocation — deletes the session row so the token can never be used again, not just a client-side action. */
  logout(token: string): void {
    this.sessions.deleteByTokenHash(hashSessionToken(token));
  }

  /** Used by the auth middleware on every protected request; also backs GET /auth/me. Returns null for a missing, unknown, or expired token — never throws for "not logged in." */
  resolveSession(token: string): User | null {
    const now = new Date().toISOString();
    const session = this.sessions.findValidByTokenHash(hashSessionToken(token), now);
    if (!session) return null;
    const user = this.users.findById(session.userId);
    if (!user) return null;
    this.sessions.touch(session.id, now);
    return user;
  }

  private issueSession(userId: string): string {
    const token = generateSessionToken();
    const now = new Date();
    this.sessions.insert({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      lastSeenAt: now.toISOString(),
    });
    return token;
  }
}
