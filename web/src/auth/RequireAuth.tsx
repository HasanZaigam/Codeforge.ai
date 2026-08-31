import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.js";
import { LoadingState } from "../components/common/LoadingState.js";

/** Gates every non-/login route — see /docs/UI_ARCHITECTURE.md "Session bootstrap". Never renders protected content before the session is resolved. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();

  if (user === undefined) {
    return <LoadingState label="Loading…" />;
  }

  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
