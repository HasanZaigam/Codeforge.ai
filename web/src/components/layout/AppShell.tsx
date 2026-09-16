import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext.js";

/**
 * The entire navigation surface: a brand mark, two links, and the signed-in user — see
 * /docs/UI_ARCHITECTURE.md "Screen structure". Deliberately not a large nav system.
 *
 * One `<header>`, restyled by CSS alone between a mobile top bar and a desktop left sidebar (see
 * `.app-header`/`.app-nav` in index.css) — never two separate DOM trees for the two layouts. That
 * keeps this a single set of nav links/buttons with stable accessible names at every viewport size,
 * so existing tests (and screen readers) never see duplicated "Settings"/"Log out" elements.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  const initials =
    user?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?";

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="app-brand">
          <span className="app-brand-mark" aria-hidden="true">
            ⟨/⟩
          </span>
          CodeForge.ai
        </NavLink>
        <nav className="app-nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            <span className="app-nav-icon" aria-hidden="true">
              ▦
            </span>
            Projects
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
            <span className="app-nav-icon" aria-hidden="true">
              ⚙
            </span>
            Settings
          </NavLink>
        </nav>
        {user && (
          <div className="user-indicator">
            <div className="user-indicator-identity">
              <span className="user-avatar" aria-hidden="true">
                {initials}
              </span>
              <div className="user-indicator-info">
                <span className="user-indicator-name">{user.name}</span>
                <span className="user-indicator-email">{user.email}</span>
              </div>
            </div>
            <button type="button" className="btn-link-muted user-indicator-logout" onClick={handleLogout}>
              Log out
            </button>
          </div>
        )}
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
