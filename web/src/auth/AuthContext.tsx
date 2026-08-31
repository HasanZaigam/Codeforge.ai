import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { authApi, ApiError, type LoginInput, type RegisterInput, type UserDTO } from "../api/index.js";
import { onUnauthenticated } from "./auth-events.js";

export interface AuthContextValue {
  /** undefined = session not resolved yet (still bootstrapping); null = resolved, not signed in. */
  user: UserDTO | null | undefined;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Session bootstrap (Step 6 instructions §20): calls GET /auth/me exactly
 * once on mount and holds `user: undefined` until it resolves, so
 * `RequireAuth` can show a loading state instead of flashing the dashboard
 * (or the login screen) before the real answer is known. Also subscribes to
 * `onUnauthenticated` so any API call that comes back 401 during normal use
 * (an expired session) clears `user` and lets `RequireAuth` redirect —
 * without needing to poll /auth/me repeatedly.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDTO | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((u) => !cancelled && setUser(u))
      .catch(() => !cancelled && setUser(null)); // 401 (or any failure) just means "not signed in"
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onUnauthenticated(() => setUser(null)), []);

  const login = useCallback(async (input: LoginInput) => {
    setUser(await authApi.login(input));
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    setUser(await authApi.register(input));
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch (err) {
      // Logout should always leave the UI signed out locally even if the request itself failed
      // (e.g. network hiccup) — the server-side session may briefly linger, but the browser
      // stops presenting the cookie as "logged in" either way.
      if (!(err instanceof ApiError)) throw err;
    } finally {
      setUser(null);
    }
  }, []);

  return <AuthContext.Provider value={{ user, login, register, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
