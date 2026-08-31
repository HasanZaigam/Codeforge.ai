-- Initial schema. See /docs/TECHNICAL_DECISIONS.md (TD-11) for why SQLite was
-- chosen for the MVP and how this migrates to Postgres later.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  coding_engine TEXT NOT NULL DEFAULT 'claude-code',
  source_control_provider TEXT NOT NULL DEFAULT 'github',
  commands_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'TODO',
  task_record_json TEXT NOT NULL,
  current_agent_run_id TEXT,
  workspace_id TEXT,
  lock_owner TEXT,
  lock_expires_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  engine TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  cost_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  provider TEXT NOT NULL,
  path TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  destroyed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspaces_task ON workspaces(task_id);

CREATE TABLE IF NOT EXISTS human_input_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'open',
  discovered TEXT NOT NULL,
  attempted_json TEXT NOT NULL,
  blocker TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  answer_json TEXT,
  asked_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_human_input_task ON human_input_requests(task_id);
