import type { NextFunction, Request, Response } from "express";

/**
 * Minimal login-attempt throttling — not a general-purpose rate limiter.
 * In-memory, per-process, fixed-window. Explicitly NOT sufficient once this
 * runs as more than one API process (each process has its own independent
 * counters) — see /docs/AUTHENTICATION.md "Known limitations" for what a
 * production deployment needs instead (a shared store, e.g. Redis — not
 * built here per this step's explicit "do not build Redis" instruction).
 */
export function loginRateLimiter(options: { windowMs: number; max: number }) {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.ip ?? "unknown"}:${typeof req.body?.email === "string" ? req.body.email.toLowerCase() : ""}`;
    const now = Date.now();
    const entry = attempts.get(key);

    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (entry.count >= options.max) {
      res.status(429).json({
        error: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts. Please wait before trying again." },
      });
      return;
    }

    entry.count += 1;
    next();
  };
}
