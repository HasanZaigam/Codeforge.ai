import { Router } from "express";
import type { AuthService } from "../../application/auth-service.js";
import { RegisterSchema, LoginSchema } from "../schemas.js";
import { toUserDTO } from "../dto.js";
import { asyncHandler } from "../async-handler.js";
import { requireAuth } from "../auth.js";
import { SESSION_COOKIE_NAME, sessionCookieOptions, parseCookies } from "../cookies.js";
import { loginRateLimiter } from "../rate-limit.js";

const loginLimiter = loginRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

/**
 * See /docs/AUTHENTICATION.md and /docs/API.md. `/auth/register` and
 * `/auth/login` are deliberately public (nothing to authenticate yet);
 * `/auth/logout` and `/auth/me` require an existing session.
 *
 * Registration is open in this MVP (no invite/admin gate) — see
 * /docs/AUTHENTICATION.md "Known limitations" for why that's acceptable
 * only behind a trusted network, same boundary as the rest of the MVP
 * (/docs/SECURITY_ARCHITECTURE.md), and what's required before it isn't.
 */
export function authRouter(auth: AuthService): Router {
  const router = Router();

  router.post(
    "/auth/register",
    loginLimiter,
    asyncHandler(async (req, res) => {
      const input = RegisterSchema.parse(req.body);
      const { user, token } = await auth.register(input);
      res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
      res.status(201).json({ user: toUserDTO(user) });
    }),
  );

  router.post(
    "/auth/login",
    loginLimiter,
    asyncHandler(async (req, res) => {
      const input = LoginSchema.parse(req.body);
      const { user, token } = await auth.login(input);
      res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
      res.json({ user: toUserDTO(user) });
    }),
  );

  router.post(
    "/auth/logout",
    asyncHandler(async (req, res) => {
      const token = parseCookies(req.headers.cookie).session;
      if (token) auth.logout(token); // server-side revocation — the row is deleted, not just the cookie
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(204).end();
    }),
  );

  router.get(
    "/auth/me",
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({ user: req.user });
    }),
  );

  return router;
}
