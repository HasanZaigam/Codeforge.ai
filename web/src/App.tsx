import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell.js";
import { RequireAuth } from "./auth/RequireAuth.js";
import { LoginPage } from "./pages/LoginPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ProjectBoardPage } from "./pages/ProjectBoardPage.js";
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
                <Route path="/projects/:projectId" element={<ProjectBoardPage />} />
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
