import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPlatform } from "../platform.js";
import { createTask } from "../orchestrator/task-factory.js";
import { createFixtureRepo } from "./fixture-repo.js";
import { createSelfFixDemoEngine, createNeedsInputDemoEngine } from "./fixture-engine-handlers.js";
import { buildTaskReport } from "../reporting/task-report.js";
import type { Project } from "../domain/types.js";

/**
 * Vertical-slice CLI harness (per /docs/MVP_SCOPE.md §16: "a CLI/test
 * harness is acceptable" — no web UI is built at this step). Runs the full
 * loop: create task -> orchestrator -> workspace -> CodingEngine adapter ->
 * validation -> (self-fix loop) -> independent review -> REVIEW state, and a
 * second run demonstrating the NEEDS_INPUT -> resume path. Uses
 * FixtureCodingEngine, not a live Claude Code CLI call — see
 * claude-code-adapter.ts for why.
 */
async function main() {
  console.log("=== Scenario A: self-fix loop reaches REVIEW ===");
  await runScenario("self-fix", createSelfFixDemoEngine());

  console.log("\n=== Scenario B: NEEDS_INPUT raised, then resumed by a human answer ===");
  await runScenario("needs-input", createNeedsInputDemoEngine(), true);
}

async function runScenario(label: string, engine: ReturnType<typeof createSelfFixDemoEngine>, expectNeedsInput = false) {
  const root = await mkdtemp(join(tmpdir(), `ai-task-manager-${label}-`));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine,
    ownerId: `demo-worker-${label}`,
  });

  const repoPath = await createFixtureRepo(root);

  const now = new Date().toISOString();

  const demoUser = {
    id: randomUUID(),
    tenantId: "default",
    email: `demo-${label}@example.com`,
    name: "Demo Developer",
    passwordHash: "", // this demo never logs in over HTTP — nothing exercises this value
    createdAt: now,
  };
  platform.users.insert(demoUser);

  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: demoUser.id,
    name: "Fixture Project",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: engine.key,
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);

  let task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix broken add() function",
    goal: "The add() function returns the wrong result — customers report totals are incorrect.",
    createdBy: null,
  });
  console.log(`Task ${task.id} created in status ${task.status}`);

  task = await platform.orchestrator.executeTask(task.id);
  console.log(`After first executeTask(): status = ${task.status}`);

  if (task.status === "NEEDS_INPUT") {
    const request = platform.humanInput.findOpenForTask(task.id);
    console.log(`NEEDS_INPUT question: "${request?.question}"`);
    console.log(`Discovered: ${request?.discovered}`);
    if (!expectNeedsInput) throw new Error(`Scenario "${label}" hit NEEDS_INPUT unexpectedly`);

    task = platform.orchestrator.submitHumanAnswer(
      task.id,
      { selectedOption: "Fix add() to return a + b", freeText: "Fix add() to return a + b" },
      demoUser.id,
    );
    console.log(`After human answer: status = ${task.status}`);

    task = await platform.orchestrator.executeTask(task.id);
    console.log(`After resumed executeTask(): status = ${task.status}`);
  }

  const agentRuns = platform.agentRuns.listForTask(task.id);
  const events = platform.taskEvents.listForTask(task.id);
  const report = buildTaskReport(task, agentRuns, events, project.defaultBranch);
  console.log("Task report:", JSON.stringify(report, null, 2));
  console.log(`Event timeline: ${events.map((e) => e.type).join(" -> ")}`);

  if (task.status !== "REVIEW") {
    throw new Error(`Scenario "${label}" expected to end in REVIEW, got ${task.status}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
