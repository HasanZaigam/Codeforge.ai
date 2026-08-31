import type { CookieOptions } from "express";
import { SESSION_TTL_MS } from "../auth/session-tokens.js";

export const SESSION_COOKIE_NAME = "session";

/**
 * No `cookie-parser` dependency — Express has no built-in *incoming* cookie
 * parsing (only `res.cookie()` for setting them), and this app only ever
 * needs to read one cookie, so a two-line manual parse is simpler than a
 * new dependency for it. See /docs/TECHNICAL_DECISIONS.md.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

/**
 * HttpOnly (unreachable from JS, closing off XSS token theft), SameSite=Lax
 * (the primary CSRF defense for this single-origin app — see
 * /docs/AUTHENTICATION.md "Browser security" for why this is enough here
 * and when it wouldn't be), Secure only outside local dev (an HTTP dev
 * server could never set a Secure cookie the browser would accept).
 */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/",
  };
}
