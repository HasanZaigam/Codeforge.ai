import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
    reviewerFeedback: null,
    humanReviewFeedback: null,
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

test("3b. the exact configured model (google/gemini-3.1-flash-lite) is passed to the real opencode invocation via --model", async () => {
  const script = `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.TEST_REPORT_FILE, JSON.stringify({ args: process.argv.slice(2) }));
    console.log(JSON.stringify({ result: "ok" }));
  `;
  const { execPath, dir } = await createMockExecutable(script);
  const reportFile = join(dir, "report.json");
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    model: "google/gemini-3.1-flash-lite",
    env: { ...process.env, TEST_REPORT_FILE: reportFile },
  });

  await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  const captured = JSON.parse(readFileSync(reportFile, "utf-8"));
  const modelFlagIndex = captured.args.indexOf("--model");
  assert.ok(modelFlagIndex !== -1, "--model flag must be present");
  assert.equal(captured.args[modelFlagIndex + 1], "google/gemini-3.1-flash-lite", "the value immediately after --model must be exactly the configured model string, unmodified");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("3c. OPENCODE_MODEL env var (not just the constructor option) resolves to the exact model passed to opencode — the actual production wiring (env-platform.ts)", async () => {
  const script = `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.TEST_REPORT_FILE, JSON.stringify({ args: process.argv.slice(2) }));
    console.log(JSON.stringify({ result: "ok" }));
  `;
  const { execPath, dir } = await createMockExecutable(script);
  const reportFile = join(dir, "report.json");
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  const originalEnvModel = process.env.OPENCODE_MODEL;
  process.env.OPENCODE_MODEL = "google/gemini-3.1-flash-lite";
  try {
    // No `model` option passed — must fall back to reading OPENCODE_MODEL from process.env at
    // construction time, exactly as env-platform.ts's resolveEngineFromEnv() does for the real
    // api/worker processes.
    const adapter = new OpenCodeAdapter({ executablePath: execPath, env: { ...process.env, TEST_REPORT_FILE: reportFile } });

    await adapter.run({
      role: "implementer",
      context: makeContextBundle(),
      workspacePath: workspaceDir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });

    const captured = JSON.parse(readFileSync(reportFile, "utf-8"));
    const modelFlagIndex = captured.args.indexOf("--model");
    assert.ok(modelFlagIndex !== -1);
    assert.equal(captured.args[modelFlagIndex + 1], "google/gemini-3.1-flash-lite");
  } finally {
    if (originalEnvModel === undefined) delete process.env.OPENCODE_MODEL;
    else process.env.OPENCODE_MODEL = originalEnvModel;
    await rm(dir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
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

test("6b. real (live-captured) OpenCode event shape: the model's natural-language answer (part.text on type:'text') becomes the summary, not the raw event stream", async () => {
  // Exact NDJSON shape as actually emitted by a real `opencode run --format json` invocation
  // against live Gemini (captured 2026-09-01, task ab150e03...) — step_start/tool_use/step_finish
  // noise interleaved with the one type:"text" record that carries the real answer at `part.text`.
  // Before this fix, none of these records had a top-level result/summary/text/message/content
  // field, so parseResult() fell through to dumping the ENTIRE raw stream as the "summary" — this
  // is the exact bug reported as "huge raw JSON blobs" in the UI and GitHub PR.
  const realEventLines = [
    { type: "step_start", timestamp: 1, sessionID: "ses_1", part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", snapshot: "abc", type: "step-start" } },
    {
      type: "tool_use",
      timestamp: 2,
      sessionID: "ses_1",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: { status: "completed", input: { command: "ls -F" }, output: "README.md.bak\nindex.js\n", metadata: {} },
        title: "ls -F",
        id: "prt_2",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    },
    {
      type: "tool_use",
      timestamp: 3,
      sessionID: "ses_1",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_2",
        state: {
          status: "completed",
          input: { filePath: "__WORKSPACE__/README.md", content: "# Simple Project\n" },
          metadata: {},
        },
        title: "README.md",
        id: "prt_3",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    },
    { type: "step_finish", timestamp: 4, sessionID: "ses_1", part: { id: "prt_4", reason: "tool-calls", snapshot: "abc", messageID: "msg_1", sessionID: "ses_1", type: "step-finish", tokens: { total: 100, input: 90, output: 10 }, cost: 0.001 } },
    { type: "step_start", timestamp: 5, sessionID: "ses_1", part: { id: "prt_5", messageID: "msg_2", sessionID: "ses_1", snapshot: "def", type: "step-start" } },
    {
      type: "text",
      timestamp: 6,
      sessionID: "ses_1",
      part: {
        id: "prt_6",
        messageID: "msg_2",
        sessionID: "ses_1",
        type: "text",
        text: "The `README.md` file has been created. I have verified the project by running `node index.js`, which output `hello` as expected.",
        time: { start: 6, end: 6 },
      },
    },
    { type: "step_finish", timestamp: 7, sessionID: "ses_1", part: { id: "prt_7", reason: "stop", snapshot: "def", messageID: "msg_2", sessionID: "ses_1", type: "step-finish", tokens: { total: 50, input: 45, output: 5 }, cost: 0.0005 } },
  ];

  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));
  const lines = realEventLines.map((l) => JSON.stringify(l).replace("__WORKSPACE__", workspaceDir));
  const script = lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n");
  const { execPath, dir } = await createMockExecutable(script);

  const adapter = new OpenCodeAdapter({ executablePath: execPath });
  const res = await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  assert.equal(res.result.status, "completed");
  assert.equal(
    res.result.summary,
    "The `README.md` file has been created. I have verified the project by running `node index.js`, which output `hello` as expected.",
    "summary must be exactly the model's natural-language text, not the raw event stream",
  );
  assert.ok(!res.result.summary.includes("step_start"), "must never contain raw event type names");
  assert.ok(!res.result.summary.includes("sessionID"), "must never contain internal session/message IDs");
  assert.ok(!res.result.summary.includes("snapshot"), "must never contain internal snapshot hashes");
  assert.deepEqual(res.result.filesChanged, ["README.md"], "the write-tool call must be extracted as a changed file, relative to the workspace");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("6c. multiple write/edit tool calls across a run all contribute to filesChanged, deduped and sorted", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));
  const mk = (tool: string, filePath: string) =>
    JSON.stringify({ type: "tool_use", part: { tool, state: { input: { filePath } } } });
  const rawScript = [
    `console.log(${JSON.stringify(mk("write", join(workspaceDir, "src/b.ts")))});`,
    `console.log(${JSON.stringify(mk("edit", join(workspaceDir, "src/a.ts")))});`,
    `console.log(${JSON.stringify(mk("write", join(workspaceDir, "src/a.ts")))}); // same file edited twice — must not duplicate`,
    `console.log(${JSON.stringify(mk("bash", "irrelevant"))}); // non-file-mutating tool — must be ignored`,
    `console.log(${JSON.stringify(JSON.stringify({ result: "Refactored two files." }))});`,
  ].join("\n");

  const { execPath, dir } = await createMockExecutable(rawScript);
  const adapter = new OpenCodeAdapter({ executablePath: execPath });
  const res = await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  assert.deepEqual(res.result.filesChanged, ["src/a.ts", "src/b.ts"]);
  assert.equal(res.result.summary, "Refactored two files.");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("6d. structured JSON parsed but no natural-language summary anywhere: synthesizes a useful placeholder from filesChanged, never dumps raw JSON", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));
  const mk = (tool: string, filePath: string) => JSON.stringify({ type: "tool_use", part: { tool, state: { input: { filePath } } } });
  const script = [`console.log(${JSON.stringify(mk("write", join(workspaceDir, "README.md")))});`].join("\n");
  const { execPath, dir } = await createMockExecutable(script);
  const adapter = new OpenCodeAdapter({ executablePath: execPath });

  const res = await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  assert.equal(res.result.summary, "Modified README.md.");
  assert.ok(!res.result.summary.includes("{\"type\""), "must never contain a raw JSON event");

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

test("12b. workspace isolation regression: PWD is forced to the real workspace directory, never inherited from the caller's own PWD", async () => {
  // Regression test for a real bug found via live smoke-testing (2026-09-01): spawn({cwd}) changes
  // the OS-level working directory of the child, but does NOT update an inherited PWD env var. When
  // this test process's own PWD (the platform repo) was passed through unchanged, OpenCode's own
  // directory resolution (used by its bash tool) trusted that stale PWD over the real cwd — so a
  // real task run ended up reading/writing files in THIS platform repository instead of the
  // isolated task workspace. See buildCleanEnvironment() in opencode-adapter.ts.
  const script = `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.TEST_REPORT_FILE, JSON.stringify({ PWD: process.env.PWD, cwd: process.cwd() }));
    console.log(JSON.stringify({ result: "OK" }));
  `;
  const { execPath, dir } = await createMockExecutable(script);
  const reportFile = join(dir, "pwd-report.json");
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  // Simulate the real bug precisely: the caller's own environment has a PWD pointing somewhere
  // completely different from the workspace being executed against (e.g. the worker process's
  // own launch directory).
  const callerEnv: NodeJS.ProcessEnv = { ...process.env, PWD: "/some/totally/different/caller/directory", TEST_REPORT_FILE: reportFile };
  const adapter = new OpenCodeAdapter({ executablePath: execPath, env: callerEnv });

  await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  const { readFileSync, realpathSync } = await import("node:fs");
  const captured = JSON.parse(readFileSync(reportFile, "utf-8"));
  const realWorkspacePath = realpathSync(workspaceDir);

  assert.equal(captured.cwd, realWorkspacePath, "the OS-level cwd must be the real workspace (this always worked)");
  // Compared via realpath on both sides — path.resolve() (used to set PWD) doesn't resolve
  // symlinks the way the OS's own getcwd() does (e.g. macOS's /var -> /private/var), so a lexical
  // string comparison would false-positive-fail here even though both point at the same directory.
  assert.equal(realpathSync(captured.PWD), realWorkspacePath, "PWD must resolve to the real workspace, never the caller's own stale PWD");
  assert.notEqual(captured.PWD, "/some/totally/different/caller/directory");

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
  // Regression: this test previously called buildPlatformFromEnv() with no DB_PATH/WORKSPACES_ROOT
  // override, so it fell through to the production default `./.data/platform.sqlite` — a path
  // relative to whatever directory `npm test` happens to be run from, whose parent directory
  // openDatabase() does NOT create (that's the caller's job — see api/server.ts and
  // worker/run-worker.ts, which both `mkdir(dirname(dbPath), {recursive:true})` first). That made
  // this test non-hermetic: it only passed by coincidence when `.data/` already existed from an
  // unrelated real run, and it wrote to the *same* file a live api/worker process might have open.
  // Every other test in this suite isolates into its own mkdtemp() directory; this one now does too.
  const root = await mkdtemp(join(tmpdir(), "opencode-config-test-"));
  const origEnv = process.env.CODING_ENGINE;
  const origDbPath = process.env.DB_PATH;
  const origWorkspacesRoot = process.env.WORKSPACES_ROOT;
  process.env.DB_PATH = join(root, "platform.sqlite");
  process.env.WORKSPACES_ROOT = join(root, "workspaces");

  const platforms: Array<{ db: { close: () => void } }> = [];
  try {
    process.env.CODING_ENGINE = "opencode";
    const p1 = buildPlatformFromEnv();
    assert.ok(p1);
    platforms.push(p1);

    process.env.CODING_ENGINE = "claude-code";
    const p2 = buildPlatformFromEnv();
    assert.ok(p2);
    platforms.push(p2);

    process.env.CODING_ENGINE = "fixture";
    const p3 = buildPlatformFromEnv();
    assert.ok(p3);
    platforms.push(p3);
  } finally {
    for (const p of platforms) p.db.close();
    process.env.CODING_ENGINE = origEnv;
    if (origDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = origDbPath;
    if (origWorkspacesRoot === undefined) delete process.env.WORKSPACES_ROOT;
    else process.env.WORKSPACES_ROOT = origWorkspacesRoot;
    await rm(root, { recursive: true, force: true });
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

// -----------------------------------------------------------------------
// Retry behavior for transient provider failures (Gemini 503, etc.) — see
// /docs/CODING_ENGINE.md "Retry behavior" and engine-failure-classifier.ts.
// -----------------------------------------------------------------------

const GEMINI_503_ERROR = JSON.stringify({
  type: "error",
  error: {
    name: "APIError",
    data: {
      message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
      statusCode: 503,
      isRetryable: true,
      responseBody: { error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } },
      metadata: { url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse" },
    },
  },
});

const RATE_LIMIT_429_ERROR = JSON.stringify({
  type: "error",
  error: {
    name: "APIError",
    data: {
      message: "Rate limit exceeded, please slow down.",
      statusCode: 429,
      isRetryable: true,
      metadata: { url: "https://api.openai.com/v1/chat/completions" },
    },
  },
});

const AUTH_401_ERROR = JSON.stringify({
  type: "error",
  error: {
    name: "APIError",
    data: {
      message: "Invalid API key provided.",
      statusCode: 401,
      isRetryable: false,
      metadata: { url: "https://api.anthropic.com/v1/messages" },
    },
  },
});

const MALFORMED_400_ERROR = JSON.stringify({
  type: "error",
  error: {
    name: "APIError",
    data: {
      message: "Invalid model specified: gemini-99-does-not-exist.",
      statusCode: 400,
      isRetryable: false,
      metadata: { url: "https://generativelanguage.googleapis.com/v1beta/models/foo" },
    },
  },
});

/** A mock `opencode` that always exits 1 with `errorJson`, tracking how many times it was invoked via a counter file. */
async function createAlwaysFailingExecutable(errorJson: string): Promise<{ execPath: string; dir: string; counterFile: string }> {
  const script = `
    import { readFileSync, writeFileSync, existsSync } from "node:fs";
    const counterFile = process.env.ATTEMPT_COUNTER_FILE;
    const n = (existsSync(counterFile) ? parseInt(readFileSync(counterFile, "utf-8"), 10) : 0) + 1;
    writeFileSync(counterFile, String(n));
    console.log(${JSON.stringify(errorJson)});
    process.exit(1);
  `;
  const { execPath, dir } = await createMockExecutable(script);
  return { execPath, dir, counterFile: join(dir, "attempts.txt") };
}

/** A mock `opencode` that fails with `errorJson` for the first `failCount` invocations, then succeeds. */
async function createEventuallySucceedingExecutable(errorJson: string, failCount: number): Promise<{ execPath: string; dir: string; counterFile: string }> {
  const script = `
    import { readFileSync, writeFileSync, existsSync } from "node:fs";
    const counterFile = process.env.ATTEMPT_COUNTER_FILE;
    const n = (existsSync(counterFile) ? parseInt(readFileSync(counterFile, "utf-8"), 10) : 0) + 1;
    writeFileSync(counterFile, String(n));
    if (n <= ${failCount}) {
      console.log(${JSON.stringify(errorJson)});
      process.exit(1);
    }
    console.log(JSON.stringify({ result: "Succeeded after retrying" }));
  `;
  const { execPath, dir } = await createMockExecutable(script);
  return { execPath, dir, counterFile: join(dir, "attempts.txt") };
}

function readCounter(counterFile: string): number {
  return existsSync(counterFile) ? parseInt(readFileSync(counterFile, "utf-8"), 10) : 0;
}

test("18. retryable 503 (Gemini, isRetryable=true): retries and eventually succeeds", async () => {
  const { execPath, dir, counterFile } = await createEventuallySucceedingExecutable(GEMINI_503_ERROR, 2);
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 3,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  const res = await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  assert.equal(res.result.status, "completed");
  assert.equal(res.result.summary, "Succeeded after retrying");
  assert.equal(readCounter(counterFile), 3, "should have spawned 3 times: 2 failures + 1 success");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("18b. retryable 429 (rate limit): retries and eventually succeeds", async () => {
  const { execPath, dir, counterFile } = await createEventuallySucceedingExecutable(RATE_LIMIT_429_ERROR, 1);
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 3,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  const res = await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  assert.equal(res.result.status, "completed");
  assert.equal(readCounter(counterFile), 2);

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

// Exact message text as actually returned by live Gemini during a real e2e verification run
// (2026-08-31) — a free-tier quota-exhaustion 429 that explicitly asks for a ~9s wait.
const QUOTA_429_ERROR_SHORT_WAIT = JSON.stringify({
  type: "error",
  error: {
    name: "APIError",
    data: {
      message: "You exceeded your current quota, please check your plan and billing details.\nPlease retry in 9.0s.",
      statusCode: 429,
      isRetryable: true,
      metadata: { url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse" },
    },
  },
});

test("18c. a provider's own suggested wait time (Gemini quota 429: 'Please retry in 9.0s') is respected, not just plain exponential backoff", async () => {
  const { execPath, dir, counterFile } = await createEventuallySucceedingExecutable(QUOTA_429_ERROR_SHORT_WAIT, 1);
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 1,
    retryBaseDelayMs: 1, // tiny plain backoff — without honoring the provider hint this would retry almost instantly
    retryMaxDelayMs: 15_000, // large enough to fit the suggested ~9s without being capped
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  const start = Date.now();
  const res = await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 15_000,
    signal: new AbortController().signal,
  });
  const elapsedMs = Date.now() - start;

  assert.equal(res.result.status, "completed");
  assert.ok(elapsedMs >= 8900, `expected the retry to wait out close to the provider's suggested 9.0s, only waited ${elapsedMs}ms`);

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("18d. a provider's suggested wait time is still capped at retryMaxDelayMs — a provider can't force an unbounded wait", async () => {
  const { execPath, dir, counterFile } = await createEventuallySucceedingExecutable(QUOTA_429_ERROR_SHORT_WAIT, 1); // suggests ~9s
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 1,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 200, // far below the suggested 9s
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  const start = Date.now();
  await adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 15_000,
    signal: new AbortController().signal,
  });
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 3000, `retryMaxDelayMs=200 must cap the wait even though the provider suggested ~9s, took ${elapsedMs}ms`);

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("19. retry exhaustion: a persistently-failing retryable 503 fails with a clear, attempt-counted message, not just 'exit code 1'", async () => {
  const { execPath, dir, counterFile } = await createAlwaysFailingExecutable(GEMINI_503_ERROR);
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 2,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  await assert.rejects(
    () =>
      adapter.run({
        role: "implementer",
        context: makeContextBundle(),
        workspacePath: workspaceDir,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      }),
    (err: unknown) => {
      assert.ok(err instanceof EngineExecutionError);
      assert.equal(err.meta?.attempts, 3, "1 initial + 2 retries");
      assert.equal(err.meta?.retryable, true);
      assert.equal(err.meta?.classification, "server_unavailable");
      assert.ok(err.message.includes("after 3 attempts"), err.message);
      assert.ok(err.message.includes("Gemini"), err.message);
      assert.ok(err.message.includes("retryable HTTP 503"), err.message);
      assert.ok(err.message.includes("UNAVAILABLE"), err.message);
      return true;
    },
  );
  assert.equal(readCounter(counterFile), 3, "should have spawned exactly maxRetries+1 times, never more");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("20. non-retryable authentication failure (401 invalid API key): fails immediately, no retries", async () => {
  const { execPath, dir, counterFile } = await createAlwaysFailingExecutable(AUTH_401_ERROR);
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 3,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  await assert.rejects(
    () =>
      adapter.run({
        role: "implementer",
        context: makeContextBundle(),
        workspacePath: workspaceDir,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      }),
    (err: unknown) => {
      assert.ok(err instanceof EngineExecutionError);
      assert.equal(err.meta?.attempts, 1, "must not retry an auth failure");
      assert.equal(err.meta?.retryable, false);
      assert.equal(err.meta?.classification, "auth");
      return true;
    },
  );
  assert.equal(readCounter(counterFile), 1, "an auth failure must never be retried, even though maxRetries=3");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("21. non-retryable malformed request (400 invalid model): fails immediately, no retries", async () => {
  const { execPath, dir, counterFile } = await createAlwaysFailingExecutable(MALFORMED_400_ERROR);
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 3,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));

  await assert.rejects(
    () =>
      adapter.run({
        role: "implementer",
        context: makeContextBundle(),
        workspacePath: workspaceDir,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      }),
    (err: unknown) => {
      assert.ok(err instanceof EngineExecutionError);
      assert.equal(err.meta?.attempts, 1);
      assert.equal(err.meta?.retryable, false);
      assert.equal(err.meta?.classification, "invalid_request");
      return true;
    },
  );
  assert.equal(readCounter(counterFile), 1);

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("22. cancellation during retry backoff stops immediately — no further spawn, rejects with EngineCancelledError", async () => {
  const { execPath, dir, counterFile } = await createAlwaysFailingExecutable(GEMINI_503_ERROR);
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 5,
    retryBaseDelayMs: 3000, // deliberately long — the abort below must preempt this wait, not outlast it
    retryMaxDelayMs: 3000,
  });
  const workspaceDir = await mkdtemp(join(tmpdir(), "opencode-ws-"));
  const controller = new AbortController();

  const promise = adapter.run({
    role: "implementer",
    context: makeContextBundle(),
    workspacePath: workspaceDir,
    timeoutMs: 10_000,
    signal: controller.signal,
  });

  // Wait for the first (failing) attempt to actually run — not a blind fixed delay, since
  // process-spawn latency on a loaded machine can exceed what used to be a safe guess, which would
  // otherwise race whether the first attempt even started before we abort — then cancel once it's
  // genuinely into the backoff wait, so the abort is guaranteed to preempt the wait rather than gamble
  // on timing.
  for (let i = 0; i < 400 && readCounter(counterFile) < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(readCounter(counterFile), 1, "the first attempt must have genuinely run before testing cancellation of the wait after it");
  controller.abort();

  const start = Date.now();
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof EngineCancelledError);
    return true;
  });
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 2000, `cancellation should preempt the 3000ms backoff wait, took ${elapsedMs}ms`);
  assert.equal(readCounter(counterFile), 1, "must not have spawned a second attempt after cancellation");

  await rm(dir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

test("23. orchestrator: retry exhaustion lands the task in FAILED with exactly one AgentRun/AGENT_FAILED, no duplicate branch/commit/PR", async () => {
  const { execPath, dir, counterFile } = await createAlwaysFailingExecutable(GEMINI_503_ERROR);
  const adapter = new OpenCodeAdapter({
    executablePath: execPath,
    env: { ...process.env, ATTEMPT_COUNTER_FILE: counterFile },
    maxRetries: 1,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
  });

  const root = await mkdtemp(join(tmpdir(), "opencode-retry-orch-"));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    engine: adapter,
    ownerId: "opencode-retry-worker",
  });

  const repoPath = await createFixtureRepo(root);
  const now = new Date().toISOString();
  const user = { id: randomUUID(), tenantId: "default", email: "retry-tester@example.com", name: "Tester", passwordHash: "", createdAt: now };
  platform.users.insert(user);
  const project: Project = {
    id: randomUUID(),
    tenantId: "default",
    ownerId: user.id,
    name: "Retry Fixture",
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
    title: "Task that will exhaust retries",
    goal: "Fix add(1, 2) to return 3",
    createdBy: null,
  });

  const executedTask = await platform.orchestrator.executeTask(task.id);

  assert.equal(executedTask.status, "FAILED");
  assert.equal(executedTask.taskRecord.pullRequest, null, "no PR should ever be created for a task that never got past the Implementer");

  const runs = platform.agentRuns.listForTask(task.id);
  assert.equal(runs.length, 1, "the low-level retries happened inside one CodingEngine.run() call — only one AgentRun row for this attempt");
  assert.equal(runs[0]?.status, "failed");

  const events = platform.taskEvents.listForTask(task.id).map((e) => e.type);
  assert.equal(events.filter((t) => t === "AGENT_FAILED").length, 1);
  assert.equal(events.filter((t) => t === "AGENT_STARTED").length, 1);
  assert.ok(events.includes("TASK_FAILED"));
  assert.ok(!events.includes("PULL_REQUEST_CREATED"));
  assert.ok(!events.includes("BRANCH_PUSHED"));

  assert.equal(readCounter(counterFile), 2, "1 initial + 1 retry (maxRetries=1), never more");

  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});
