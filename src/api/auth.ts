import type { NextFunction, Request, Response } from "express";
import type { AuthService } from "../application/auth-service.js";
import { SESSION_COOKIE_NAME, parseCookies } from "./cookies.js";

/**
 * Real authentication middleware (Step 6) — replaces the Step 3 placeholder
 * that trusted a client-supplied `x-user-id` header. See
 * /docs/AUTHENTICATION.md for the full design.
 *
 * The identity attached to `req.user` always comes from a server-validated
 * session cookie, resolved through `AuthService.resolveSession` — never
 * from anything the client asserts in a header or body. Application
 * services and the Orchestrator are unaffected: they still only ever see a
 * plain `actorId` string, exactly as they did with the old placeholder (see
 * TECHNICAL_DECISIONS.md TD-19's "one-file change" claim — this is that
 * file).
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedUser;
  }
}

function readSessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie).session ?? undefined;
}

/** Attaches req.user if a valid session cookie is present; never rejects the request itself — see requireAuth for the protected-route boundary. */
export function attachUser(auth: AuthService) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = readSessionToken(req);
    if (token) {
      const user = auth.resolveSession(token);
      if (user) req.user = { id: user.id, email: user.email, name: user.name };
    }
    next();
  };
}

/** Protects a route: 401s if attachUser did not find a valid session. Applied per-router, never globally — /auth/* and /health stay reachable unauthenticated. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } });
    return;
  }
  next();
}

export { SESSION_COOKIE_NAME };
