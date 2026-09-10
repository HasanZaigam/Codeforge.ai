-- Concurrency V1: lease-generation fencing (see /docs/TASK_LIFECYCLE.md "Worker concurrency and
-- lease loss", TECHNICAL_DECISIONS.md TD-12).
--
-- `tasks.lock_generation` is an OWNERSHIP EPOCH, not a version counter for every field change: it
-- advances only when the execution *lease* changes hands (an unowned/expired task is claimed, or an
-- already-WORKING task's lease is (re-)claimed via TaskRepository.claimTodo / claimWorking /
-- claimReviewForHumanFeedback). It deliberately does NOT advance on a same-owner heartbeat renewal
-- (see TaskRepository.renewWorkingLease) — a live execution renewing its own still-valid lease is
-- not a new owner. Every successful claim captures the *resulting* generation as that execution's
-- "ownership identity" (see Orchestrator.runWorkingEpisode/runHumanFeedbackFixCycle threading
-- `generation` through the execution path); every write that must not be allowed to land after this
-- execution has lost the lease to someone else is fenced by comparing against the CURRENT
-- lock_generation at write time (`TaskRepository.saveOwned`), not the value captured at claim time.
--
-- Backward compatible by construction: every existing row gets lock_generation = 0 (no execution has
-- ever fenced a write against it yet — the first real claim after this migration takes it to 1).
ALTER TABLE tasks ADD COLUMN lock_generation INTEGER NOT NULL DEFAULT 0;

-- `agent_runs.owner_generation` records the `tasks.lock_generation` this specific AgentRun was
-- created under (see Orchestrator.runAgent). AgentRunRepository.complete() re-checks this against
-- the task's CURRENT lock_generation at completion time — not the value passed in at insert time —
-- so a stale execution (operating under an old generation) can never complete/overwrite an AgentRun
-- after a newer owner has already taken over the task's lease. See AgentRunRepository.complete's own
-- doc comment.
ALTER TABLE agent_runs ADD COLUMN owner_generation INTEGER NOT NULL DEFAULT 0;

-- `workspaces.active_generation` is the smallest-safe fencing this milestone adds around the shared,
-- mutable per-task working directory (see /docs/SECURITY_ARCHITECTURE.md, LocalGitWorkspaceProvider):
-- it does NOT redesign workspace isolation (still one directory per task, no per-generation clones),
-- it only prevents two different execution generations from unknowingly believing they both own the
-- same "ready" workspace at once. Orchestrator.provisionWorkspace claims the workspace for its own
-- generation with a strictly-increasing UPDATE (see WorkspaceRepository.claimForGeneration) before
-- ever handing it back to the caller to write into; a stale generation trying to reuse a workspace a
-- newer generation already claimed loses that UPDATE and aborts via LeaseLostError instead of racing
-- files on disk with the new owner.
ALTER TABLE workspaces ADD COLUMN active_generation INTEGER NOT NULL DEFAULT 0;
