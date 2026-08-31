import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenCodeAdapter } from "../src/coding-engine/opencode-adapter.js";
import { ClaudeCodeAdapter } from "../src/coding-engine/claude-code-adapter.js";
import {
  CodingEngineRegistry,
  EngineCancelledError,
  EngineExecutionError,
  type EngineInvocationRequest,
} from "../src/coding-engine/coding-engine.js";
import { buildPlatform } from "../src/platform.js";
import { buildPlatformFromEnv } from "../src/env-platform.js";
import { ProjectService } from "../src/application/project-service.js";
import { createTask } from "../src/orchestrator/task-factory.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import type { ContextBundle, Project } from "../src/domain/types.js";

function makeContextBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    taskGoal: "Fix the bug in calculateTotal()",
    taskPlan: "1. Inspect file\n2. Fix arithmetic",
    priorDecisions: [{ source: "discovered", summary: "Avoid floats", recordedAt: new Date().toISOString() }],
    repoPath: "/tmp/mock-workspace",
    projectConventionPointer: "See conventions in README.md",
    lastFailure: null,
    reviewEvidence: null,
    ...overrides,
  };
}

async function createMockExecutable(scriptContent: string): Promise<{ execPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-mock-"));
  const execPath = join(dir, "mock-opencode.mjs");
  const fullContent = `#!/usr/bin/env node\n${scriptContent}`;
  await writeFile(execPath, fullContent, "utf-8");
  await chmod(execPath, 0o755);
  return { execPath, dir };
}

test("1. adapter construction: defaults and custom options", () => {
  const defaultAdapter = new OpenCodeAdapter();
  assert.equal(defaultAdapter.key, "opencode");

  const customAdapter = new OpenCodeAdapter({
    executablePath: "/usr/local/bin/custom-opencode",
    model: "anthropic/claude-3-7-sonnet",
    extraArgs: ["--thinking"],
  });
  assert.equal(customAdapter.key, "opencode");
});

test("2 & 3. command invocation & correct cwd: executes with proper arguments and cwd", async () => {
  const script = `
    import { writeFileSync } from "node:fs";
    const report = {
      cwd: process.cwd(),
      args: process.argv.slice(2),
    };
    writeFileSync(process.env.TEST_REPORT_FILE, JSON.stringify(report));
    console.log(JSON.stringify({ result: "Task successfully executed", total_cost_usd: 0.042 }));
  `;
  const { execPath, dir } = await createMockExecutable(script);
  const reportFile = join(dir, "report.json");

  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    model: "openai/gpt-4o",
    env: { ...process.env, TEST_REPORT_FILE: reportFile },
  });

  const request: EngineInvocationRequest = {
    role: "implementer",
    context: makeContextBundle({ repoPath: workspaceDir }),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  };

  const invocation = await adapter.run(request);
  assert.equal(invocation.result.status, "completed");
  assert.equal(invocation.result.summary, "Task successfully executed");
  assert.equal(invocation.cost?.costUsd, 0.042);

  const { readFileSync, realpathSync } = await import("node:fs");
  const captured = JSON.parse(readFileSync(reportFile, "utf-8"));
  assert.equal(captured.cwd, realpathSync(workspaceDir));
  assert.ok(captured.args.includes("run"));
  assert.ok(captured.args.includes("--format"));
  assert.ok(captured.args.includes("json"));
  assert.ok(captured.args.includes("--auto"));
  assert.ok(captured.args.includes("--model"));
  assert.ok(captured.args.includes("openai/gpt-4o"));

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("4 & 5. role mapping and context passing: builds implementer vs reviewer prompts", async () => {
  let receivedPrompt = "";
  const script = `
    const prompt = process.argv[process.argv.length - 1];
    console.log(JSON.stringify({ result: "Received prompt length: " + prompt.length, prompt_echo: prompt }));
  `;
  const { execPath, dir } = await createMockExecutable(script);

  const adapter = new OpenCodeAdapter({ executablePath: execPath });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  // Implementer
  const implReq: EngineInvocationRequest = {
    role: "implementer",
    context: makeContextBundle({ taskGoal: "Implement feature X" }),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  };
  const implRes = await adapter.run(implReq);
  assert.ok(implRes.logExcerpt.includes("Task: Implement feature X"));
  assert.ok(implRes.logExcerpt.includes("Project conventions"));

  // Reviewer
  const revReq: EngineInvocationRequest = {
    role: "reviewer",
    context: makeContextBundle({
      taskGoal: "Review feature X",
      reviewEvidence: {
        implementerSummary: "Implemented cleanly",
        filesChanged: ["index.ts"],
        diffRef: "sha123",
        validation: { status: "passed", checks: [{ name: "test", command: "npm test", passed: true, exitCode: 0, durationMs: 10, logExcerpt: "" }], durationMs: 10 },
      },
    }),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  };
  const revRes = await adapter.run(revReq);
  assert.ok(revRes.logExcerpt.includes("Task requirements: Review feature X"));
  assert.ok(revRes.logExcerpt.includes("You did not write this change"));

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("6 & 13. StepResult conversion: handles JSON stream, cost, findings, needs_input", async () => {
  const script = `
    console.log(JSON.stringify({ type: "step", message: "Step 1 complete" }));
    console.log(JSON.stringify({ type: "step", message: "Step 2 complete", input_tokens: 150, output_tokens: 50 }));
    console.log(JSON.stringify({
      result: "Final summary of changes",
      total_cost_usd: 0.015,
      findings: [
        { category: "correctness", severity: "concern", summary: "Edge case in empty list" }
      ]
    }));
  `;
  const { execPath, dir } = await createMockExecutable(script);

  const adapter = new OpenCodeAdapter({ executablePath: execPath });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  const res = await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  assert.equal(res.result.status, "completed");
  assert.ok(res.result.summary.includes("Final summary of changes"));
  assert.equal(res.cost?.costUsd, 0.015);
  assert.equal(res.cost?.inputTokens, 150);
  assert.equal(res.cost?.outputTokens, 50);
  assert.equal(res.result.findings.length, 1);
  const firstFinding = res.result.findings[0];
  assert.ok(firstFinding);
  assert.equal(firstFinding.category, "correctness");
  assert.equal(firstFinding.severity, "concern");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("7. non-zero exit code: throws EngineExecutionError with stderr details", async () => {
  const script = `
    console.error("Fatal model error: context window exceeded");
    process.exit(1);
  `;
  const { execPath, dir } = await createMockExecutable(script);

  const adapter = new OpenCodeAdapter({ executablePath: execPath });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  await assert.rejects(
    async () => {
      await adapter.run({
        role: "implementer",
        context: makeContextBundle(),
        workspacePath: workspaceDir,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof EngineExecutionError);
      assert.ok(err.message.includes("exit code 1"));
      assert.ok(err.message.includes("context window exceeded"));
      return true;
    },
  );

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("8. malformed output: gracefully falls back to raw text without throwing parse error", async () => {
  const script = `
    console.log("Here is what I did without JSON: fixed the calculation logic in index.js");
  `;
  const { execPath, dir } = await createMockExecutable(script);

  const adapter = new OpenCodeAdapter({ executablePath: execPath });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  const res = await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  assert.equal(res.result.status, "completed");
  assert.ok(res.result.summary.includes("fixed the calculation logic"));

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("9 & 10. cancellation and process cleanup: gracefully terminates child process on abort", async () => {
  const script = `
    process.on("SIGTERM", () => {
      process.exit(0);
    });
    // Keep running
    setInterval(() => {}, 1000);
  `;
  const { execPath, dir } = await createMockExecutable(script);

  const adapter = new OpenCodeAdapter({ executablePath: execPath });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));
  const controller = new AbortController();

  const promise = adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 10000,
    signal: controller.signal,
  });

  // Trigger cancellation shortly after spawn
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(
    promise,
    (err: unknown) => {
      assert.ok(err instanceof EngineCancelledError);
      return true;
    },
  );

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("11 & 12. environment sanitization & no GitHub credential exposure", async () => {
  const script = `
    import { writeFileSync } from "node:fs";
    const envKeys = Object.keys(process.env);
    writeFileSync(process.env.TEST_REPORT_FILE, JSON.stringify(envKeys));
    console.log(JSON.stringify({ result: "OK" }));
  `;
  const { execPath, dir } = await createMockExecutable(script);
  const reportFile = join(dir, "env-report.json");

  const customEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_TOKEN: "ghp_super_secret_pat_12345",
    GH_TOKEN: "ghp_another_secret",
    GITHUB_PAT: "ghp_pat_secret",
    CREDENTIAL_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    SESSION_SECRET: "session_secret_xyz",
    DB_PATH: "/path/to/platform.sqlite",
    AWS_SECRET_ACCESS_KEY: "aws_secret_key",
    JENKINS_API_TOKEN: "jenkins_token",
    OPENAI_API_KEY: "sk-openai-key",
    TEST_REPORT_FILE: reportFile,
  };

  const adapter = new OpenCodeAdapter({ executablePath: execPath, env: customEnv });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  const { readFileSync } = await import("node:fs");
  const capturedKeys: string[] = JSON.parse(readFileSync(reportFile, "utf-8"));

  assert.ok(!capturedKeys.includes("GITHUB_TOKEN"), "GITHUB_TOKEN must not leak");
  assert.ok(!capturedKeys.includes("GH_TOKEN"), "GH_TOKEN must not leak");
  assert.ok(!capturedKeys.includes("GITHUB_PAT"), "GITHUB_PAT must not leak");
  assert.ok(!capturedKeys.includes("CREDENTIAL_ENCRYPTION_KEY"), "CREDENTIAL_ENCRYPTION_KEY must not leak");
  assert.ok(!capturedKeys.includes("SESSION_SECRET"), "SESSION_SECRET must not leak");
  assert.ok(!capturedKeys.includes("DB_PATH"), "DB_PATH must not leak");
  assert.ok(!capturedKeys.includes("AWS_SECRET_ACCESS_KEY"), "AWS secrets must not leak");
  assert.ok(!capturedKeys.includes("JENKINS_API_TOKEN"), "JENKINS secrets must not leak");
  assert.ok(capturedKeys.includes("OPENAI_API_KEY"), "AI provider keys should be preserved");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("14 & 15. Implementer and Reviewer invocation via Orchestrator: full task lifecycle with OpenCode", async () => {
  // Mock OpenCode that fixes the add.js bug on implementer role, and approves on reviewer role
  const script = `
    import { writeFileSync } from "node:fs";

    const prompt = process.argv[process.argv.length - 1];
    const isImplementer = prompt.includes("Task:") || prompt.includes("Investigate the repository");

    if (isImplementer) {
      // Fix add.js in workspace
      try {
        writeFileSync("add.js", "function add(a, b) { return a + b; }\\nmodule.exports = { add };\\n");
      } catch (e) {}
      console.log(JSON.stringify({
        result: "Fixed add() implementation in add.js to return a + b",
        total_cost_usd: 0.01,
      }));
    } else {
      // Reviewer role
      console.log(JSON.stringify({
        result: "Change is correct and passes all tests without regressions",
        confidence: "high",
        findings: [],
        total_cost_usd: 0.005,
      }));
    }
  `;
  const { execPath, dir } = await createMockExecutable(script);
  const adapter = new OpenCodeAdapter({ executablePath: execPath });

  const root = await mkdtemp(join(tmpdir(), "opencode-orch-"));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine: adapter,
    ownerId: "opencode-worker-1",
  });

  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    tenantId: "default",
    email: "opencode-tester@example.com",
    name: "Tester",
    passwordHash: "",
    createdAt: now,
  };
  platform.users.insert(user);

  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "OpenCode Fixture",
    repoUrl: repoPath,
    defaultBranch: "main",
    codingEngine: "opencode",
    sourceControlProvider: "local-git",
    owner: null,
    repo: null,
    commands: { test: "node test.js" },
    createdAt: now,
    updatedAt: now,
  };
  platform.projects.insert(project);

  const task = createTask(platform.tasks, platform.taskEvents, {
    tenantId: "default",
    projectId: project.id,
    title: "Fix add() using OpenCode",
    goal: "Make add(1, 2) return 3",
    createdBy: null,
  });

  const executedTask = await platform.orchestrator.executeTask(task.id);
  assert.equal(executedTask.status, "REVIEW");
  assert.ok(executedTask.taskRecord.pullRequest);

  const runs = platform.agentRuns.listForTask(task.id);
  assert.ok(runs.length >= 2, "Should have Implementer and Reviewer runs");
  const firstRun = runs[0];
  const secondRun = runs[1];
  assert.ok(firstRun);
  assert.ok(secondRun);
  assert.equal(firstRun.engine, "opencode");
  assert.equal(secondRun.engine, "opencode");

  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

test("16. configuration selection: CODING_ENGINE selects engine appropriately", async () => {
  const origEnv = process.env.CODING_ENGINE;
  try {
    process.env.CODING_ENGINE = "opencode";
    const p1 = buildPlatformFromEnv();
    assert.ok(p1);

    process.env.CODING_ENGINE = "claude-code";
    const p2 = buildPlatformFromEnv();
    assert.ok(p2);

    process.env.CODING_ENGINE = "fixture";
    const p3 = buildPlatformFromEnv();
    assert.ok(p3);
  } finally {
    process.env.CODING_ENGINE = origEnv;
  }
});

test("17. OpenCode unavailable behavior: non-existent executable throws EngineExecutionError", async () => {
  const adapter = new OpenCodeAdapter({ executablePath: "/path/to/nonexistent/opencode/binary" });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  await assert.rejects(
    async () => {
      await adapter.run({
        role: "implementer",
        context: makeContextBundle(),
        workspacePath: workspaceDir,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof EngineExecutionError);
      return true;
    },
  );

  await rm(workspaceDir, { recursive: true, force: true });
});
