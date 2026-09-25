import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProjectsPage } from "../pages/ProjectsPage.js";
import { ProjectLayout } from "../pages/ProjectLayout.js";
import { ProjectOverviewPage } from "../pages/ProjectOverviewPage.js";
import { ProjectTasksPage } from "../pages/ProjectTasksPage.js";
import { ProjectBacklogPage } from "../pages/ProjectBacklogPage.js";
import { BacklogItemPage } from "../pages/BacklogItemPage.js";
import { ProjectWorkspacePage } from "../pages/ProjectWorkspacePage.js";
import { ProjectSettingsPage } from "../pages/ProjectSettingsPage.js";
import { TaskDetailPage } from "../pages/TaskDetailPage.js";

/**
 * Renders the same *protected* route table App.tsx nests under RequireAuth,
 * without the auth gate itself — used by page-level tests (ProjectsPage,
 * ProjectLayout and its tab pages, TaskDetailPage) that assume an
 * authenticated session and don't need to re-exercise login/logout. See
 * App.test.tsx for the tests that do exercise the auth gate end-to-end.
 */
export function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<ProjectOverviewPage />} />
          <Route path="tasks" element={<ProjectTasksPage />} />
          <Route path="backlog" element={<ProjectBacklogPage />} />
          <Route path="backlog/:itemId" element={<BacklogItemPage />} />
          <Route path="workspace" element={<ProjectWorkspacePage />} />
          <Route path="settings" element={<ProjectSettingsPage />} />
        </Route>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

export function renderPage(ui: ReactElement, initialPath = "/") {
  return render(<MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>);
}
