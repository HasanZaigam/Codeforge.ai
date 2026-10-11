import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell.js";
import { RequireAuth } from "./auth/RequireAuth.js";
import { LoginPage } from "./pages/LoginPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ProjectLayout } from "./pages/ProjectLayout.js";
import { ProjectOverviewPage } from "./pages/ProjectOverviewPage.js";
import { ProjectTasksPage } from "./pages/ProjectTasksPage.js";
import { BacklogItemPage } from "./pages/BacklogItemPage.js";
import { ProjectWorkspacePage } from "./pages/ProjectWorkspacePage.js";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage.js";
import { ProjectEvaluationPage } from "./pages/ProjectEvaluationPage.js";
import { TaskDetailPage } from "./pages/TaskDetailPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

export function App() {
  useEffect(() => {
    if (import.meta.env.DEV) {
      fetch("/api/health")
        .then((r) => r.json())
        .then((data) => {
          console.log(`[CodeForge Dev] API Runtime Identity:`, data);
          (window as unknown as Record<string, unknown>).__CODEFORGE_HEALTH__ = data;
        })
        .catch(() => {});
    }
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <AppShell>
              <Routes>
                <Route path="/" element={<ProjectsPage />} />
                <Route path="/projects/:projectId" element={<ProjectLayout />}>
                  <Route index element={<ProjectOverviewPage />} />
                  <Route path="tasks" element={<ProjectTasksPage />} />
                  {/* Legacy — Issues & Requests is no longer primary navigation (Phase 4C: Chat inside
                      Overview is now the intake surface). The list page redirects to Overview; the item
                      detail page stays reachable (e.g. from a Chat suggestion's "view details") without
                      being a nav destination itself. Neither route nor its backing service was deleted. */}
                  <Route path="backlog" element={<Navigate to="" replace />} />
                  <Route path="backlog/:itemId" element={<BacklogItemPage />} />
                  <Route path="workspace" element={<ProjectWorkspacePage />} />
                  <Route path="settings" element={<ProjectSettingsPage />} />
                  <Route path="evaluation" element={<ProjectEvaluationPage />} />
                </Route>
                <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
