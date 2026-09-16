import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell.js";
import { RequireAuth } from "./auth/RequireAuth.js";
import { LoginPage } from "./pages/LoginPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ProjectLayout } from "./pages/ProjectLayout.js";
import { ProjectOverviewPage } from "./pages/ProjectOverviewPage.js";
import { ProjectTasksPage } from "./pages/ProjectTasksPage.js";
import { ProjectWorkspacePage } from "./pages/ProjectWorkspacePage.js";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage.js";
import { TaskDetailPage } from "./pages/TaskDetailPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

export function App() {
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
                  <Route path="workspace" element={<ProjectWorkspacePage />} />
                  <Route path="settings" element={<ProjectSettingsPage />} />
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
