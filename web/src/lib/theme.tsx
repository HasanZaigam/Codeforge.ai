import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "codeforge-theme";

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage can be unavailable (private mode, blocked site data) — fall back to the system theme.
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

const ThemeContext = createContext<{ theme: ThemePreference; setTheme: (theme: ThemePreference) => void }>({
  theme: "system",
  setTheme: () => {},
});

/** Applies the `.dark` class shadcn's tokens key off, following the stored preference or the OS setting. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredPreference);

  useEffect(() => {
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [theme]);

  function setTheme(next: ThemePreference) {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-persistent is fine — the choice still applies for this session.
    }
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
