import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.js";
import { ErrorState } from "../components/common/ErrorState.js";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

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
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col justify-center px-4 py-12 sm:px-8">
        <div className="mx-auto w-full max-w-sm space-y-8">
          <div className="space-y-2">
            <span
              className="flex size-10 items-center justify-center rounded-xl bg-primary font-mono text-sm font-bold text-primary-foreground"
              aria-hidden="true"
            >
              {"</>"}
            </span>
            <h1 className="pt-4 text-2xl font-semibold">CodeForge.ai</h1>
            <p className="text-sm text-muted-foreground">
              {mode === "login" ? "Sign in to your projects." : "Create an account to get started."}
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            <FieldGroup>
              {mode === "register" && (
                <Field>
                  <FieldLabel htmlFor="auth-name">Name</FieldLabel>
                  <Input id="auth-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="auth-email">Email</FieldLabel>
                <Input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="auth-password">Password</FieldLabel>
                <Input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "register" ? 10 : undefined}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                />
                {mode === "register" && <FieldDescription>At least 10 characters.</FieldDescription>}
              </Field>

              {error && <ErrorState message={error} />}

              <Button type="submit" size="lg" className="w-full" disabled={submitting}>
                {submitting && <Spinner data-icon="inline-start" />}
                {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
              </Button>
            </FieldGroup>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError(undefined);
              }}
            >
              {mode === "login" ? "Need an account? Create one" : "Already have an account? Sign in"}
            </Button>
          </p>
        </div>
      </div>

      <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-end lg:p-12">
        <div
          className="absolute inset-0 opacity-20 [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:24px_24px]"
          aria-hidden="true"
        />
        <div className="relative max-w-md space-y-4">
          <p className="font-heading text-3xl leading-tight font-semibold">
            Plain-language tasks in. Reviewed pull requests out.
          </p>
          <p className="text-primary-foreground/80">
            CodeForge investigates, implements, tests, self-fixes and reviews against your real repository — and only
            asks you when a genuine decision is needed.
          </p>
        </div>
      </aside>
    </div>
  );
}
