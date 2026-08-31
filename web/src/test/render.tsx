import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProjectsPage } from "../pages/ProjectsPage.js";
import { ProjectBoardPage } from "../pages/ProjectBoardPage.js";
import { TaskDetailPage } from "../pages/TaskDetailPage.js";

/**
 * Renders the same *protected* route table App.tsx nests under RequireAuth,
 * without the auth gate itself — used by page-level tests (ProjectsPage,
 * ProjectBoardPage, TaskDetailPage) that assume an authenticated session and
 * don't need to re-exercise login/logout. See App.test.tsx for the tests
 * that do exercise the auth gate end-to-end.
 */
export function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectBoardPage />} />
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

export function renderPage(ui: ReactElement, initialPath = "/") {
  return render(<MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>);
}
