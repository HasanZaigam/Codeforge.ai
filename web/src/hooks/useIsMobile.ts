import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 767px)";

function currentlyMobile(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * The one piece of JS-driven responsive branching in the app — everywhere else, layout is handled
 * entirely by CSS media queries on a single DOM tree (see index.css). This hook exists only because
 * the Tasks screen needs two genuinely different *representations* on mobile vs. desktop (a vertical
 * filtered list vs. a Kanban board), not just a restyled one — see ProjectTasksPage.
 *
 * jsdom (the test environment) has no `matchMedia`, so `currentlyMobile()` safely resolves to
 * `false` there — every existing desktop-oriented test keeps exercising the Kanban board unchanged
 * unless a test explicitly stubs `window.matchMedia` to simulate a narrow viewport.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(currentlyMobile);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const handler = () => setIsMobile(mql.matches);
    handler();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isMobile;
}
