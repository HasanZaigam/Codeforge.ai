import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { ErrorState } from "../components/common/ErrorState.js";

/**
 * One page, two modes (sign in / create account) — see Step 6 instructions
 * §21: "keep login simple." No separate /register route; no password-reset
 * flow (documented as a Known Limitation in docs/AUTHENTICATION.md, not
 * silently missing).
 */
export function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: Location } };

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      if (mode === "login") {
        await login({ email, password });
      } else {
        await register({ email, password, name });
      }
      const from = location.state?.from?.pathname ?? "/";
      navigate(from, { replace: true });
    } catch (err) {
      // The API already returns a generic "Invalid email or password" for login (see
      // /docs/AUTHENTICATION.md) — never more specific than that, whatever the underlying cause.
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="card card-padded auth-card">
        <h1 style={{ marginBottom: 4 }}>AI Developer</h1>
        <p className="text-muted" style={{ marginBottom: 24 }}>
          {mode === "login" ? "Sign in to your projects." : "Create an account to get started."}
        </p>

        <form onSubmit={handleSubmit}>
          {mode === "register" && (
            <div className="field">
              <label htmlFor="auth-name">Name</label>
              <input id="auth-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
            </div>
          )}
          <div className="field">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "register" ? 10 : undefined}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
            {mode === "register" && <p className="field-hint">At least 10 characters.</p>}
          </div>

          {error && <ErrorState message={error} />}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting} style={{ marginTop: 8 }}>
            {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <button
          type="button"
          className="btn-link-muted"
          style={{ marginTop: 16 }}
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(undefined);
          }}
        >
          {mode === "login" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
