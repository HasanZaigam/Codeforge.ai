-- Multi-repository projects. A project used to BE one repository (projects.repo_url/owner/repo/
-- default_branch/source_control_provider/commands_json). Now a project is a container that can hold
-- several repositories (e.g. frontend, backend, admin) — or exactly one, for a monorepo — and every
-- task and backlog item targets exactly ONE of them (see docs/TECHNICAL_DECISIONS.md TD-62).
--
-- `project_repos` is the source of truth for repository identity and per-repository settings. The
-- old columns on `projects` are left in place (SQLite can't drop them without a table rebuild) but
-- are no longer read: ProjectRepository projects a Project's repository fields from its PRIMARY
-- (earliest-connected) repository instead.
CREATE TABLE IF NOT EXISTS project_repos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  -- Short, human label unique within the project ("frontend", "backend") — what tasks and Chat refer to.
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  source_control_provider TEXT NOT NULL,
  owner TEXT,
  repo TEXT,
  commands_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_project_repos_project ON project_repos(project_id, created_at);

-- Backfill: every existing project becomes a project with exactly one repository. The repository row
-- reuses the project's id as its own id — unique within this table, deterministic, and it makes the
-- task/backlog backfill below a plain copy of project_id.
INSERT INTO project_repos (id, project_id, name, repo_url, default_branch, source_control_provider, owner, repo, commands_json, created_at, updated_at)
SELECT id, id, COALESCE(NULLIF(repo, ''), 'repository'), repo_url, default_branch, source_control_provider, owner, repo, commands_json, created_at, updated_at
FROM projects
WHERE repo_url <> '' AND id NOT IN (SELECT project_id FROM project_repos);

ALTER TABLE tasks ADD COLUMN repository_id TEXT REFERENCES project_repos(id);
UPDATE tasks SET repository_id = project_id WHERE repository_id IS NULL AND project_id IN (SELECT id FROM project_repos);

ALTER TABLE backlog_items ADD COLUMN repository_id TEXT REFERENCES project_repos(id);
UPDATE backlog_items SET repository_id = project_id WHERE repository_id IS NULL AND project_id IN (SELECT id FROM project_repos);

-- An "existing branch" task locks its branch against a second concurrent task — but only within the
-- SAME repository now: frontend's `main` and backend's `main` are different branches.
DROP INDEX IF EXISTS idx_tasks_active_existing_branch;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_existing_branch
  ON tasks(project_id, repository_id, working_branch)
  WHERE branch_mode = 'existing' AND status NOT IN ('DONE', 'FAILED', 'CANCELLED');
