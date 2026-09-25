import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildPlatform } from "../src/platform.js";
import { buildApp } from "../src/api/app.js";
import { buildPlatformFromEnv } from "../src/env-platform.js";
import { createFixtureRepo } from "../src/cli/fixture-repo.js";
import { EngineCancelledError, EngineExecutionError, EngineTimeoutError } from "../src/coding-engine/coding-engine.js";
import { ModelRegistry, UNKNOWN_CAPABILITY_PROFILE, inferProviderId } from "../src/routing/model-registry.js";
import { ConfigError, validateSharedConfig } from "../src/config/startup-config.js";
import { Worker, type BackgroundRunner } from "../src/worker/worker.js";
import type { BacklogAnalysisJob } from "../src/backlog/backlog-types.js";
import { registerClient } from "./helpers/auth-client.js";
import { DEFAULT_PATHS, ScriptedEngine, fakeStructure, json, setupBacklogHarness, validAnalysis, type BacklogHarness, type BacklogHarnessOptions } from "./helpers/backlog-harness.js";

/**
 * Phase 4A.1 — backlog analysis is executed by the WORKER, not the API process. These tests drive the
 * worker side (`platform.backlogRunner`, and the real `Worker` class) against real SQLite with a
 * scripted CodingEngine (never a real model). "A worker" here is a Platform + runner; a second
 * `secondProcess()` is a second worker process sharing the same database file.
 */

const past = "2000-01-01T00:00:00.000Z";
const future = () => new Date(Date.now() + 3_600_000).toISOString();

async function withHarness(label: string, options: BacklogHarnessOptions, fn: (h: BacklogHarness) => Promise<void>): Promise<void> {
  const h = await setupBacklogHarness(label, options);
  try {
    await fn(h);
  } finally {
    await h.platform.backlogRunner.stop();
    h.close();
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A gate a scripted engine can block on until the test releases it. */
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

const job = (h: BacklogHarness, id: string): BacklogAnalysisJob => h.platform.backlogJobs.findById(id)!;
const makeDue = (h: BacklogHarness, id: string) => h.platform.db.prepare("UPDATE backlog_analysis_jobs SET available_at = ? WHERE id = ?").run(past, id);
const itemStatus = (h: BacklogHarness, id: string) => h.platform.backlogItems.findById(id)!.status;

function registryOf(...models: Array<[string, string]>): ModelRegistry {
  const registry = new ModelRegistry();
  for (const [modelId, providerId] of models) {
    registry.register({ modelId, providerId, displayName: modelId, engineKey: "fixture", capability: UNKNOWN_CAPABILITY_PROFILE, contextWindow: null, credentialMode: "managed", enabled: true });
  }
  return registry;
}

const FAST_RETRY = { infrastructureRetryBaseDelayMs: 40, infrastructureRetryMaxDelayMs: 200 } as const;

// ===========================================================================
// The API never runs a model; the worker does
// ===========================================================================

test("job lifecycle: QUEUED (nothing runs) -> worker claims -> RUNNING with owner/lease/attempt -> SUCCEEDED with a result reference and no claim left", async () => {
  const gate = latch();
  await withHarness("lifecycle", { respond: async () => { await gate.promise; return json(validAnalysis()); } }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    assert.equal(queued.status, "QUEUED");
    assert.equal(queued.attemptCount, 0);
    assert.equal(queued.claimOwner, null);
    assert.equal(h.engine.calls.length, 0);

    await h.platform.backlogRunner.tick(); // returns as soon as the job is started — never waits for the model
    await waitFor(() => h.engine.calls.length === 1, "the model call to start");
    const running = job(h, queued.id);
    assert.equal(running.status, "RUNNING");
    assert.equal(running.attemptCount, 1);
    assert.equal(running.lockGeneration, 1);
    assert.ok(running.claimOwner, "a running job records its owner");
    assert.ok(running.leaseExpiresAt! > new Date().toISOString(), "and holds a live lease");
    assert.ok(running.startedAt);
    assert.equal(h.platform.backlogRunner.inFlightCount, 1);

    gate.release();
    await h.platform.backlogRunner.idle();
    const done = job(h, queued.id);
    assert.equal(done.status, "SUCCEEDED");
    assert.equal(done.claimOwner, null);
    assert.equal(done.leaseExpiresAt, null);
    assert.ok(done.completedAt);
    assert.equal(done.analysisId, h.platform.backlogAnalyses.findLatestForItem(item.id)!.id);
    assert.equal(itemStatus(h, item.id), "ANALYZED");
  });
});

test("the API-side service holds no analyzer and no model can be reached from an HTTP-shaped call path", async () => {
  await withHarness("api-no-model", {}, async (h) => {
    const item = h.item("x");
    h.services.backlog.requestAnalysis(item.id, h.owner.id);
    h.services.backlog.getItem(item.id, h.owner.id);
    h.services.backlog.cancelAnalysis(item.id, h.owner.id);
    assert.equal(h.engine.calls.length, 0);
    const source = readFileSync(join(process.cwd(), "src/application/backlog-service.ts"), "utf8");
    assert.ok(!/backlog-analyzer|context-builder|CodingEngine/.test(source), "backlog-service.ts must not import the analyzer, context builder or an engine");
  });
});

// ===========================================================================
// Failure handling reuses the existing taxonomy
// ===========================================================================

test("malformed model output is NEVER retried: one attempt, FAILED, item to NEEDS_CLARIFICATION", async () => {
  await withHarness("malformed-no-retry", { respond: () => "this is not json", platform: { orchestratorConfig: FAST_RETRY } }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.drain();
    makeDue(h, queued.id);
    await h.platform.backlogRunner.drain();
    const j = job(h, queued.id);
    assert.equal(j.status, "FAILED");
    assert.equal(j.failureCategory, "malformed_output");
    assert.equal(j.attemptCount, 1, "a model repeating the same mistake is not infrastructure — never retried");
    assert.equal(h.engine.calls.length, 1);
    assert.equal(itemStatus(h, item.id), "NEEDS_CLARIFICATION");
    assert.equal(h.platform.backlogAnalyses.findById(j.analysisId!)!.failureCategory, "malformed_output");
  });
});

test("permanent failures are terminal at once: authentication and invalid-request/config errors are never retried", async () => {
  for (const classification of ["auth", "invalid_request"] as const) {
    await withHarness(`permanent-${classification}`, {
      respond: () => { throw new EngineExecutionError("reviewer", `${classification} failure`, { attempts: 1, retryable: false, classification }); },
    }, async (h) => {
      const item = h.item("x");
      const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
      await h.platform.backlogRunner.drain();
      makeDue(h, queued.id);
      await h.platform.backlogRunner.drain();
      const j = job(h, queued.id);
      assert.equal(j.status, "FAILED", classification);
      assert.equal(j.attemptCount, 1, classification);
      assert.equal(h.engine.calls.length, 1, classification);
      assert.equal(itemStatus(h, item.id), "NEW", "returned to its pre-analysis status");
    });
  }
});

test("an unclassifiable error is terminal (never retried blindly)", async () => {
  await withHarness("unknown-error", { respond: () => { throw new Error("segfault in tool"); } }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.drain();
    assert.equal(job(h, queued.id).status, "FAILED");
    assert.equal(job(h, queued.id).attemptCount, 1);
  });
});

test("a retryable provider failure is requeued with a backoff (item stays ANALYZING, no result row, provider cools down) and the next attempt can succeed", async () => {
  let n = 0;
  await withHarness("retry-then-succeed", {
    platform: { modelRegistry: registryOf(["model-a", "prov-a"]), orchestratorConfig: FAST_RETRY },
    respond: () => {
      if (n++ === 0) throw new EngineExecutionError("reviewer", "429 quota exhausted", { attempts: 4, retryable: true, classification: "rate_limit" });
      return json(validAnalysis());
    },
  }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.drain();

    const retrying = job(h, queued.id);
    assert.equal(retrying.status, "QUEUED", "requeued, not failed");
    assert.equal(retrying.attemptCount, 1);
    assert.equal(retrying.failureCategory, "engine_error");
    assert.match(retrying.failureReason!, /429 quota exhausted/);
    assert.ok(retrying.availableAt > new Date().toISOString(), "a backoff is in effect");
    assert.equal(retrying.claimOwner, null);
    assert.equal(retrying.modelId, "model-a");
    assert.equal(itemStatus(h, item.id), "ANALYZING", "still awaiting analysis");
    assert.equal(h.platform.backlogAnalyses.countForItem(item.id), 0, "an intermediate attempt leaves no result row");
    const retryEvent = h.services.backlog.getItem(item.id, h.owner.id).events.find((e) => e.type === "ANALYSIS_RETRY_SCHEDULED")!;
    assert.equal(retryEvent.payload.attempt, 1);
    assert.equal(retryEvent.payload.maxAttempts, 3);
    assert.equal(typeof retryEvent.payload.retryInMs, "number");
    assert.equal(h.platform.providerHealth.get("prov-a")?.state, "cooldown", "the SAME provider-health record task execution uses");

    // While the backoff is pending, a worker tick claims nothing.
    await h.platform.backlogRunner.drain();
    assert.equal(h.engine.calls.length, 1);

    // Backoff elapsed (and the provider recovered): the retry runs and succeeds.
    makeDue(h, queued.id);
    h.platform.db.prepare("DELETE FROM provider_health").run();
    await h.platform.backlogRunner.drain();
    const done = job(h, queued.id);
    assert.equal(done.status, "SUCCEEDED");
    assert.equal(done.attemptCount, 2);
    assert.equal(itemStatus(h, item.id), "ANALYZED");
    assert.equal(h.platform.backlogAnalyses.countForItem(item.id), 1, "exactly one final result");
  });
});

test("retries are BOUNDED: after max attempts the job fails terminally with one recorded failed analysis", async () => {
  await withHarness("retry-bounded", {
    platform: { orchestratorConfig: FAST_RETRY },
    respond: () => { throw new EngineTimeoutError("reviewer", 1000); },
  }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    assert.equal(queued.maxAttempts, 3, "default = maxInfrastructureRetries (2) + 1");
    for (let i = 0; i < 5; i++) {
      await h.platform.backlogRunner.drain();
      makeDue(h, queued.id);
    }
    const j = job(h, queued.id);
    assert.equal(j.status, "FAILED");
    assert.equal(j.attemptCount, 3);
    assert.equal(j.failureCategory, "timeout");
    assert.equal(h.engine.calls.length, 3, "one model call per attempt, never more");
    assert.equal(itemStatus(h, item.id), "NEW");
    assert.equal(h.platform.backlogAnalyses.countForItem(item.id), 1);
    assert.equal(h.platform.backlogAnalyses.findById(j.analysisId!)!.status, "failed");
    const retryEvents = h.services.backlog.getItem(item.id, h.owner.id).events.filter((e) => e.type === "ANALYSIS_RETRY_SCHEDULED");
    assert.equal(retryEvents.length, 2, "two retries scheduled, then the third attempt failed for good");
  });
});

test("every model cooling down defers the job until the cooldown ends (no engine call), then it runs", async () => {
  await withHarness("defer-cooldown", {
    platform: { modelRegistry: registryOf(["model-a", "prov-a"], ["model-b", "prov-b"]), orchestratorConfig: FAST_RETRY },
  }, async (h) => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    for (const providerId of ["prov-a", "prov-b"]) {
      h.platform.providerHealth.upsert({ providerId, state: "cooldown", consecutiveFailures: 1, lastFailureAt: new Date().toISOString(), lastFailureCategory: "provider_quota_exhausted", cooldownUntil: until, updatedAt: new Date().toISOString() });
    }
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.drain();
    const deferred = job(h, queued.id);
    assert.equal(deferred.status, "QUEUED");
    assert.equal(deferred.failureCategory, "no_model_available");
    assert.equal(h.engine.calls.length, 0, "no call against a provider already known to be cooling down");
    const waitMs = Date.parse(deferred.availableAt) - Date.now();
    assert.ok(waitMs > 5 * 60_000 && waitMs <= 10 * 60_000 + 1000, `waits for the cooldown (~10 min), got ${waitMs}ms`);

    h.platform.db.prepare("DELETE FROM provider_health").run();
    makeDue(h, queued.id);
    await h.platform.backlogRunner.drain();
    assert.equal(job(h, queued.id).status, "SUCCEEDED");
    assert.equal(job(h, queued.id).attemptCount, 2);
  });
});

test("fallback to a different model happens inside ONE attempt and is recorded", async () => {
  await withHarness("job-fallback", {
    platform: { modelRegistry: registryOf(["model-a", "prov-a"], ["model-b", "prov-b"]) },
    respond: (request) => {
      if (request.modelSelection?.modelId === "model-a") throw new EngineTimeoutError("reviewer", 1000);
      return json(validAnalysis());
    },
  }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.drain();
    const j = job(h, queued.id);
    assert.equal(j.status, "SUCCEEDED");
    assert.equal(j.attemptCount, 1);
    assert.equal(j.modelId, "model-b");
    assert.equal(h.platform.backlogAnalyses.findById(j.analysisId!)!.fallbackIndex, 1);
  });
});

// ===========================================================================
// Provider-agnostic, registry-driven
// ===========================================================================

test("the model comes from the registry, and an operator-stated <provider>/<model> id resolves to its provider", async () => {
  const modelId = "google/gemini-3.1-flash-lite";
  await withHarness("registry", { platform: { modelRegistry: registryOf([modelId, inferProviderId(modelId)]) } }, async (h) => {
    const item = h.item("x");
    await h.analyze(item.id);
    assert.equal(h.engine.calls[0]!.modelSelection?.modelId, modelId);
    const analysis = h.platform.backlogAnalyses.findLatestForItem(item.id)!;
    assert.equal(analysis.modelId, modelId);
    assert.equal(analysis.providerId, "google", "not 'unknown'");
    assert.equal(h.platform.providerHealth.get("google")?.state, "healthy");
  });
});

test("no vendor/provider is hardcoded anywhere in the backlog domain, the executor, the runner or the analyzer", () => {
  const files = [
    ...readdirSync(join(process.cwd(), "src/backlog")).map((f) => join("src/backlog", f)),
    "src/application/backlog-service.ts",
    "src/application/backlog-analysis-executor.ts",
    "src/worker/backlog-analysis-runner.ts",
    "src/persistence/repositories/backlog-analysis-job-repository.ts",
  ];
  const vendor = /gemini|claude|anthropic|openai|\bgpt\b|gpt-\d|grok|deepseek|llama|mistral|opencode/i;
  for (const f of files) {
    const code = readFileSync(join(process.cwd(), f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    assert.ok(!vendor.test(code), `${f} must not name a model vendor or engine in code`);
  }
});

// ===========================================================================
// Ownership, lease, crash recovery
// ===========================================================================

test("two workers: while A holds a live claim, B cannot claim the same job — and B claims a DIFFERENT job", async () => {
  await withHarness("two-workers", { platform: { backlogOptions: { maxAnalysisConcurrency: 5 } } }, async (h) => {
    const a = h.item("a");
    const b = h.item("b");
    const ja = h.services.backlog.requestAnalysis(a.id, h.owner.id).job;
    const jb = h.services.backlog.requestAnalysis(b.id, h.owner.id).job;
    const jobs = h.platform.backlogJobs;
    const lease = () => new Date(Date.now() + 60_000).toISOString();
    const claimedByA = jobs.claimNext("worker-A", new Date().toISOString(), lease(), 5)!;
    assert.equal(claimedByA.id, ja.id);
    const claimedByB = jobs.claimNext("worker-B", new Date().toISOString(), lease(), 5)!;
    assert.equal(claimedByB.id, jb.id, "B gets the other job, never A's");
    assert.equal(jobs.claimNext("worker-B", new Date().toISOString(), lease(), 5), null, "nothing else runnable");
    assert.equal(jobs.findById(ja.id)!.claimOwner, "worker-A");
    assert.equal(jobs.findById(jb.id)!.claimOwner, "worker-B");
  });
});

test("worker crash: an expired lease is recovered by another worker, exactly one final result exists", async () => {
  await withHarness("crash-recovery", {}, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    // Worker A claims and "crashes": its lease is already expired and it will never write anything again.
    const dead = h.platform.backlogJobs.claimNext("worker-A-dead", new Date().toISOString(), past, 5)!;
    assert.equal(dead.id, queued.id);
    assert.equal(job(h, queued.id).status, "RUNNING");
    assert.equal(job(h, queued.id).attemptCount, 1);

    const b = h.secondProcess();
    try {
      await b.platform.backlogRunner.drain();
      const j = job(h, queued.id);
      assert.equal(j.status, "SUCCEEDED");
      assert.equal(j.attemptCount, 2, "the recovery claim counts as an attempt");
      assert.equal(j.lockGeneration, 2, "a new generation fences the dead worker");
      assert.equal(itemStatus(h, item.id), "ANALYZED");
      assert.equal(h.platform.backlogAnalyses.countForItem(item.id), 1);
      assert.equal((h.platform.db.prepare("SELECT COUNT(*) AS n FROM backlog_relationships").get() as { n: number }).n, 0);
    } finally {
      b.platform.db.close();
    }
  });
});

test("a stale worker that wakes up after being replaced is fenced out: its result is discarded and NOTHING is left half-written", async () => {
  const gateA = latch();
  let callsA = 0;
  await withHarness("stale-worker", {
    respond: async () => {
      callsA++;
      await gateA.promise;
      return json(validAnalysis({ summary: "STALE result from the replaced worker" }));
    },
  }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.tick();
    await waitFor(() => callsA === 1, "worker A's model call");

    // A's lease "lapses"; worker B takes the job over and finishes it first.
    h.platform.db.prepare("UPDATE backlog_analysis_jobs SET lease_expires_at = ? WHERE id = ?").run(past, queued.id);
    const b = h.secondProcess(new ScriptedEngine(() => json(validAnalysis({ summary: "FRESH result from worker B" }))));
    try {
      await b.platform.backlogRunner.drain();
      assert.equal(job(h, queued.id).status, "SUCCEEDED");
      assert.equal(job(h, queued.id).lockGeneration, 2);

      gateA.release();
      await h.platform.backlogRunner.idle();
      assert.equal(h.platform.backlogAnalyses.countForItem(item.id), 1, "the stale result was rolled back completely");
      assert.equal(h.platform.backlogAnalyses.findLatestForItem(item.id)!.result!.summary, "FRESH result from worker B");
      assert.equal(job(h, queued.id).lockGeneration, 2);
      assert.equal(job(h, queued.id).analysisId, h.platform.backlogAnalyses.findLatestForItem(item.id)!.id);
      assert.equal(itemStatus(h, item.id), "ANALYZED");
    } finally {
      b.platform.db.close();
    }
  });
});

test("heartbeat keeps a slow-but-alive analysis's lease alive, so no other worker ever takes it", async () => {
  const gate = latch();
  await withHarness("heartbeat", {
    respond: async () => { await gate.promise; return json(validAnalysis()); },
    platform: { backlogOptions: { analysisLeaseMs: 150, analysisHeartbeatMs: 30 } },
  }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.tick();
    await waitFor(() => h.engine.calls.length === 1, "the call to start");
    await new Promise((r) => setTimeout(r, 500)); // several lease lengths
    assert.equal(h.platform.backlogJobs.claimNext("worker-thief", new Date().toISOString(), future(), 5), null, "the lease never lapsed");
    assert.ok(job(h, queued.id).leaseExpiresAt! > new Date().toISOString());
    gate.release();
    await h.platform.backlogRunner.idle();
    assert.equal(job(h, queued.id).status, "SUCCEEDED");
  });
});

test("a worker whose heartbeat finds its claim was lost aborts its model call and discards silently", async () => {
  let aborted = false;
  await withHarness("lease-lost", {
    respond: (request) => new Promise<string>((_, reject) => request.signal.addEventListener("abort", () => { aborted = true; reject(new EngineCancelledError("reviewer")); })),
    platform: { backlogOptions: { analysisLeaseMs: 5000, analysisHeartbeatMs: 30 } },
  }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.tick();
    await waitFor(() => h.engine.calls.length === 1, "the call to start");
    // Another worker legitimately takes over: generation bumps under A's feet.
    h.platform.db.prepare("UPDATE backlog_analysis_jobs SET lock_generation = lock_generation + 1, claim_owner = 'someone-else' WHERE id = ?").run(queued.id);
    await waitFor(() => aborted, "worker A to notice and abort");
    await h.platform.backlogRunner.idle();
    const j = job(h, queued.id);
    assert.equal(j.claimOwner, "someone-else", "A did not touch the job it no longer owns");
    assert.equal(j.status, "RUNNING");
    assert.equal(h.platform.backlogAnalyses.countForItem(item.id), 0);
  });
});

test("crash LOOP is bounded: a job whose lease keeps expiring is failed as 'interrupted' once attempts run out, and never runs again", async () => {
  await withHarness("crash-loop", {
    platform: { backlogOptions: { analysisMaxAttempts: 2 } },
  }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    assert.equal(queued.maxAttempts, 2);
    h.platform.backlogJobs.claimNext("dead-1", new Date().toISOString(), past, 5); // attempt 1, crashes
    h.platform.backlogJobs.claimNext("dead-2", new Date().toISOString(), past, 5); // attempt 2, crashes
    assert.equal(job(h, queued.id).attemptCount, 2);
    assert.equal(h.platform.backlogJobs.claimNext("worker-C", new Date().toISOString(), future(), 5), null, "out of attempts: not claimable for another run");

    await h.platform.backlogRunner.drain();
    const j = job(h, queued.id);
    assert.equal(j.status, "FAILED");
    assert.equal(j.failureCategory, "interrupted");
    assert.equal(h.engine.calls.length, 0, "no model call for a crash-looping job");
    assert.equal(itemStatus(h, item.id), "NEW", "the item is released back to its pre-analysis status");
    assert.equal(h.platform.backlogAnalyses.findById(j.analysisId!)!.failureCategory, "interrupted");
  });
});

test("an expired lease does not hold a concurrency slot (a crashed worker never blocks the cap)", async () => {
  await withHarness("expired-slot", {}, async (h) => {
    const item = h.item("x");
    h.services.backlog.requestAnalysis(item.id, h.owner.id);
    h.platform.backlogJobs.claimNext("dead", new Date().toISOString(), past, 5);
    assert.equal(h.platform.backlogJobs.countRunning(new Date().toISOString()), 0);
  });
});

// ===========================================================================
// Cancellation
// ===========================================================================

test("cancelling a RUNNING analysis: the worker aborts the model call at its next heartbeat and settles CANCELLED, releasing the item", async () => {
  let aborted = false;
  await withHarness("cancel-running", {
    respond: (request) => new Promise<string>((_, reject) => request.signal.addEventListener("abort", () => { aborted = true; reject(new EngineCancelledError("reviewer")); })),
    platform: { backlogOptions: { analysisLeaseMs: 5000, analysisHeartbeatMs: 30 } },
  }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    await h.platform.backlogRunner.tick();
    await waitFor(() => h.engine.calls.length === 1, "the call to start");

    const { job: requested } = h.services.backlog.cancelAnalysis(item.id, h.owner.id);
    assert.equal(requested.status, "RUNNING", "a running job is asked to stop, not yanked");
    assert.notEqual(requested.cancelRequestedAt, null);
    assert.equal(h.services.backlog.cancelAnalysis(item.id, h.owner.id).job.id, queued.id, "idempotent");

    await waitFor(() => aborted, "the worker to abort the call");
    await h.platform.backlogRunner.idle();
    const j = job(h, queued.id);
    assert.equal(j.status, "CANCELLED");
    assert.equal(j.claimOwner, null);
    assert.equal(itemStatus(h, item.id), "NEW");
    assert.equal(h.platform.backlogAnalyses.countForItem(item.id), 0, "a cancel is not a failed analysis");
    assert.ok(h.services.backlog.getItem(item.id, h.owner.id).events.some((e) => e.type === "ANALYSIS_CANCELLED"));
  });
});

test("a cancel requested before a worker got to the job is honored the moment it is claimed — no model call", async () => {
  await withHarness("cancel-before-claim", {}, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    h.platform.db.prepare("UPDATE backlog_analysis_jobs SET cancel_requested_at = ? WHERE id = ?").run(new Date().toISOString(), queued.id);
    await h.platform.backlogRunner.drain();
    assert.equal(job(h, queued.id).status, "CANCELLED");
    assert.equal(h.engine.calls.length, 0);
    assert.equal(itemStatus(h, item.id), "NEW");
  });
});

test("cancelling a QUEUED analysis is immediate; with nothing live, cancel is a 409-class error", async () => {
  await withHarness("cancel-queued", {}, async (h) => {
    const item = h.item("x");
    assert.throws(() => h.services.backlog.cancelAnalysis(item.id, h.owner.id), /no analysis in progress/);
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    const { job: cancelled, item: after } = h.services.backlog.cancelAnalysis(item.id, h.owner.id);
    assert.equal(cancelled.id, queued.id);
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(after.status, "NEW");
    await h.platform.backlogRunner.drain();
    assert.equal(h.engine.calls.length, 0);
  });
});

// ===========================================================================
// Global concurrency cap
// ===========================================================================

test("the runner never starts more analyses than the cap on one worker", async () => {
  const gate = latch();
  await withHarness("local-cap", {
    respond: async () => { await gate.promise; return json(validAnalysis()); },
    platform: { backlogOptions: { maxAnalysisConcurrency: 2 } },
  }, async (h) => {
    for (let i = 0; i < 5; i++) h.services.backlog.requestAnalysis(h.item(`item ${i}`).id, h.owner.id);
    await h.platform.backlogRunner.tick();
    await h.platform.backlogRunner.tick();
    await waitFor(() => h.engine.calls.length === 2, "two analyses");
    assert.equal(h.platform.backlogRunner.inFlightCount, 2);
    assert.equal(h.platform.backlogJobs.countRunning(new Date().toISOString()), 2);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.engine.calls.length, 2, "the other three wait");
    gate.release();
    await h.platform.backlogRunner.drain();
    assert.equal((h.platform.db.prepare("SELECT COUNT(*) AS n FROM backlog_analysis_jobs WHERE status = 'SUCCEEDED'").get() as { n: number }).n, 5);
  });
});

test("GLOBAL cap across workers: 3 worker processes, cap 2, 6 jobs — never more than 2 live model calls in total, and no duplicate results", async () => {
  const CAP = 2;
  const state = { active: 0, max: 0, started: 0 };
  let releaseAll = latch();
  const respond = async () => {
    state.active++;
    state.started++;
    state.max = Math.max(state.max, state.active);
    await releaseAll.promise;
    state.active--;
    return json(validAnalysis());
  };
  await withHarness("global-cap", { respond, platform: { backlogOptions: { maxAnalysisConcurrency: CAP } } }, async (h) => {
    const w2 = h.secondProcess(new ScriptedEngine(respond));
    const w3 = h.secondProcess(new ScriptedEngine(respond));
    const runners = [h.platform.backlogRunner, w2.platform.backlogRunner, w3.platform.backlogRunner];
    try {
      const items = Array.from({ length: 6 }, (_, i) => h.item(`item ${i}`));
      const jobIds = items.map((i) => h.services.backlog.requestAnalysis(i.id, h.owner.id).job.id);

      // Every worker polls, repeatedly and concurrently, while the first analyses are still in flight.
      for (let round = 0; round < 5; round++) {
        await Promise.all(runners.map((r) => r.tick()));
        assert.ok(h.platform.backlogJobs.countRunning(new Date().toISOString()) <= CAP, "DB-observed RUNNING never exceeds the cap");
      }
      await waitFor(() => state.active === CAP, `${CAP} analyses to be in flight`);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(state.active, CAP);
      assert.equal(h.platform.backlogJobs.countRunning(new Date().toISOString()), CAP);
      assert.ok(state.max <= CAP, `max concurrent model calls was ${state.max}`);

      // Let them all finish, letting the remaining jobs flow through the (still capped) workers.
      releaseAll.release();
      for (let round = 0; round < 40; round++) {
        await Promise.all(runners.map((r) => r.tick()));
        assert.ok(h.platform.backlogJobs.countRunning(new Date().toISOString()) <= CAP);
        await Promise.all(runners.map((r) => r.idle()));
        if (jobIds.every((id) => job(h, id).status === "SUCCEEDED")) break;
      }
      assert.ok(state.max <= CAP, `max concurrent model calls across all workers was ${state.max}`);
      assert.equal(state.started, 6, "each job ran exactly once");
      for (const id of jobIds) {
        assert.equal(job(h, id).status, "SUCCEEDED");
        assert.equal(job(h, id).attemptCount, 1);
      }
      for (const item of items) assert.equal(h.platform.backlogAnalyses.countForItem(item.id), 1, "no duplicate final result");
    } finally {
      await Promise.all([w2, w3].map((w) => w.platform.backlogRunner.stop()));
      w2.platform.db.close();
      w3.platform.db.close();
    }
  });
});

test("the cap is enforced by the atomic claim UPDATE itself, not just the cheap pre-check (the guard that holds when two workers race)", async () => {
  await withHarness("cap-update-guard", {}, async (h) => {
    const jobs = h.platform.backlogJobs;
    for (let i = 0; i < 3; i++) h.services.backlog.requestAnalysis(h.item(`item ${i}`).id, h.owner.id);
    const lease = new Date(Date.now() + 60_000).toISOString();
    assert.ok(jobs.claimNext("w1", new Date().toISOString(), lease, 2));
    assert.ok(jobs.claimNext("w2", new Date().toISOString(), lease, 2));
    assert.equal(jobs.countRunning(new Date().toISOString()), 2);

    // Simulate the race window: a worker whose pre-check read a STALE count of 0 (another worker's claim
    // committed between its check and its UPDATE). Only the UPDATE's own in-statement count can save us.
    jobs.countRunning = () => 0;
    assert.equal(jobs.claimNext("w3-racing", new Date().toISOString(), lease, 2), null, "the UPDATE must refuse the third slot even when the pre-check was fooled");
    delete (jobs as unknown as Record<string, unknown>).countRunning;
    assert.equal(jobs.countRunning(new Date().toISOString()), 2);
  });
});

test("the attempt bound is enforced by the claim itself: an exhausted, lapsed job can never be claimed for another run, even if candidate selection offered it", async () => {
  await withHarness("attempt-update-guard", { platform: { backlogOptions: { analysisMaxAttempts: 1 } } }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    assert.ok(h.platform.backlogJobs.claimNext("dead", new Date().toISOString(), past, 5)); // attempt 1 of 1, then the worker dies
    assert.equal(job(h, queued.id).attemptCount, 1);
    // The orphan is settled (FAILED/interrupted) rather than re-run; a claim never hands it out again.
    assert.equal(h.platform.backlogJobs.claimNext("worker-2", new Date().toISOString(), future(), 5), null);
    assert.equal(job(h, queued.id).attemptCount, 1);
    assert.equal(job(h, queued.id).claimOwner, "dead");
  });
});

test("the cap also bounds crash RECOVERY: recovered jobs do not push past it", async () => {
  const gate = latch();
  await withHarness("cap-recovery", {
    respond: async () => { await gate.promise; return json(validAnalysis()); },
    platform: { backlogOptions: { maxAnalysisConcurrency: 1 } },
  }, async (h) => {
    const [a, b] = [h.item("a"), h.item("b")];
    h.services.backlog.requestAnalysis(a.id, h.owner.id);
    h.services.backlog.requestAnalysis(b.id, h.owner.id);
    await h.platform.backlogRunner.tick();
    await waitFor(() => h.engine.calls.length === 1, "the first analysis");
    await h.platform.backlogRunner.tick();
    assert.equal(h.engine.calls.length, 1, "the second waits for the slot");
    gate.release();
    await h.platform.backlogRunner.drain();
    assert.equal(h.engine.calls.length, 2);
  });
});

test("MAX_BACKLOG_ANALYSIS_CONCURRENCY is validated at startup with a safe default", async () => {
  for (const bad of ["0", "-1", "abc", "1.5", "17", "1000"]) {
    assert.throws(() => validateSharedConfig({ MAX_BACKLOG_ANALYSIS_CONCURRENCY: bad } as NodeJS.ProcessEnv), ConfigError, bad);
  }
  for (const ok of [undefined, "", "1", "2", "16"]) {
    assert.doesNotThrow(() => validateSharedConfig({ MAX_BACKLOG_ANALYSIS_CONCURRENCY: ok } as NodeJS.ProcessEnv), String(ok));
  }

  // The production wiring resolves it (default 2, override honored).
  const root = await mkdtemp(join(tmpdir(), "backlog-cap-env-"));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { CODING_ENGINE: "fixture", DB_PATH: join(root, "a.sqlite"), WORKSPACES_ROOT: join(root, "ws"), PROJECT_WORKSPACE_ROOT: join(root, "pws") });
    delete process.env.MAX_BACKLOG_ANALYSIS_CONCURRENCY;
    const dflt = buildPlatformFromEnv("t1");
    assert.equal(dflt.backlogOptions.maxAnalysisConcurrency, 2);
    dflt.db.close();
    process.env.MAX_BACKLOG_ANALYSIS_CONCURRENCY = "3";
    process.env.DB_PATH = join(root, "b.sqlite");
    const custom = buildPlatformFromEnv("t2");
    assert.equal(custom.backlogOptions.maxAnalysisConcurrency, 3);
    custom.db.close();
    process.env.MAX_BACKLOG_ANALYSIS_CONCURRENCY = "0";
    assert.throws(() => buildPlatformFromEnv("t3"), ConfigError);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// ===========================================================================
// Security
// ===========================================================================

test("security: another user (or another project's owner) cannot enqueue, cancel or read a job for an item they don't own", async () => {
  await withHarness("job-authz", {}, async (h) => {
    const intruder = h.addUser("intruder");
    const item = h.item("secret");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    assert.throws(() => h.services.backlog.requestAnalysis(item.id, intruder.id), /not found/i);
    assert.throws(() => h.services.backlog.cancelAnalysis(item.id, intruder.id), /not found/i);
    assert.throws(() => h.services.backlog.getLatestAnalysisJob(item.id, intruder.id), /not found/i);
    assert.equal(job(h, queued.id).status, "QUEUED", "the intruder changed nothing");
  });
});

test("security: analyses running through the worker never create Tasks, proposals, agent runs, or start anything", async () => {
  await withHarness("no-auto", {}, async (h) => {
    for (let i = 0; i < 4; i++) h.services.backlog.requestAnalysis(h.item(`item ${i}`).id, h.owner.id);
    const worker = new Worker(h.platform.tasks, h.platform.orchestrator, { pollIntervalMs: 60_000 }, () => {}, h.platform.backlogRunner);
    await worker.tick();
    await h.platform.backlogRunner.idle();
    await worker.tick(); // the global cap (default 2) means the other two start on the next tick
    await h.platform.backlogRunner.idle();
    const count = (t: string) => (h.platform.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    assert.equal(count("tasks"), 0);
    assert.equal(count("agent_runs"), 0);
    assert.equal(count("task_events"), 0);
    assert.equal(count("task_proposals"), 0);
    assert.equal(count("workspaces"), 0, "no workspace was provisioned");
    assert.equal(count("backlog_analyses"), 4);
    await worker.stop();
  });
});

test("security: a job's failure text is redacted before it is stored or returned", async () => {
  const name = "CODEFORGE_TEST_JOB_API_KEY";
  const secret = "sk-live-job-secret-value-424242";
  process.env[name] = secret;
  try {
    await withHarness("job-redact", { respond: () => { throw new Error(`upstream 401: key ${secret} rejected`); } }, async (h) => {
      const item = h.item("x");
      const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
      await h.platform.backlogRunner.drain();
      const everything = JSON.stringify([h.platform.db.prepare("SELECT * FROM backlog_analysis_jobs").all(), h.platform.db.prepare("SELECT * FROM backlog_events").all(), h.services.backlog.getItem(item.id, h.owner.id).latestAnalysis]);
      assert.ok(!everything.includes(secret));
      assert.match(job(h, queued.id).failureReason!, /\[REDACTED:CODEFORGE_TEST_JOB_API_KEY\]/);
    });
  } finally {
    delete process.env[name];
  }
});

test("security: relationship context stays inside the project when analysis runs on a worker", async () => {
  await withHarness("job-isolation", {}, async (h) => {
    const other = await h.services.projects.create({ name: "Other", sourceControlProvider: "local-git", repoUrl: h.project.repoUrl, codingEngine: "fixture" }, h.owner.id);
    h.services.backlog.createItem(other.id, { title: "Foreign secret title", description: "foreign body", externalRef: "F-1" }, h.owner.id);
    const item = h.item("mine");
    await h.analyze(item.id);
    assert.ok(!h.engine.calls[0]!.promptOverride!.includes("Foreign secret"));
  });
});

// ===========================================================================
// Worker integration (the real Worker class) and the HTTP -> DB job -> worker -> result flow
// ===========================================================================

test("Worker.tick starts analysis without waiting for it, and Worker.stop hands unfinished jobs back", async () => {
  const gate = latch();
  await withHarness("worker-class", { respond: async () => { await gate.promise; return json(validAnalysis()); } }, async (h) => {
    const item = h.item("x");
    const { job: queued } = h.services.backlog.requestAnalysis(item.id, h.owner.id);
    const worker = new Worker(h.platform.tasks, h.platform.orchestrator, { pollIntervalMs: 60_000 }, () => {}, h.platform.backlogRunner);

    await worker.tick(); // must return while the model call is still blocked
    await waitFor(() => h.engine.calls.length === 1, "the model call");
    assert.equal(job(h, queued.id).status, "RUNNING");

    // Graceful stop: the in-flight analysis is aborted only if it honors the signal — ours doesn't, so release it first.
    gate.release();
    await worker.stop();
    assert.equal(job(h, queued.id).status, "SUCCEEDED");
  });
});

test("an analysis-side failure in the worker tick never prevents task dispatch", async () => {
  await withHarness("worker-isolated", {}, async (h) => {
    const exploding: BackgroundRunner = { tick: async () => { throw new Error("runner exploded"); }, stop: async () => {} };
    let recovered = 0;
    const original = h.platform.orchestrator.recoverOrphanedTasks.bind(h.platform.orchestrator);
    h.platform.orchestrator.recoverOrphanedTasks = () => { recovered++; return original(); };
    const worker = new Worker(h.platform.tasks, h.platform.orchestrator, { pollIntervalMs: 60_000 }, () => {}, exploding);
    await assert.doesNotReject(() => worker.tick());
    assert.equal(recovered, 1, "the task half of the tick still ran");
  });
});

test("integration: HTTP enqueue -> DB job -> worker claim -> scripted engine -> persisted analysis -> polled over HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "backlog-worker-http-"));
  const engine = new ScriptedEngine(() => json(validAnalysis({ summary: "analysed on the worker" })));
  const platform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces"),
    projectWorkspacesRoot: join(root, "project-workspaces"),
    engine,
    ownerId: "api-process",
    repositoryStructureProvider: fakeStructure(DEFAULT_PATHS),
  });
  const apiApp = buildApp(platform);
  const server = await new Promise<Server>((resolve) => {
    const s = apiApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  // A SEPARATE platform on the same database file is "the worker process".
  const workerPlatform = buildPlatform({
    dbPath: join(root, "platform.sqlite"),
    workspacesRoot: join(root, "workspaces-worker"),
    projectWorkspacesRoot: join(root, "project-workspaces"),
    engine,
    ownerId: "worker-process",
    repositoryStructureProvider: fakeStructure(DEFAULT_PATHS),
  });
  try {
    const client = await registerClient(`http://127.0.0.1:${address.port}`, "wk");
    const repo = await createFixtureRepo(root);
    const project = ((await (await client.fetch("/projects", { method: "POST", body: JSON.stringify({ name: "P", sourceControlProvider: "local-git", repoUrl: repo, codingEngine: "fixture" }) })).json()) as { project: { id: string } }).project;
    const created = (await (await client.fetch(`/projects/${project.id}/backlog`, { method: "POST", body: JSON.stringify({ title: "OTP spam", description: "d", externalRef: "B-1" }) })).json()) as { item: { id: string } };

    const enqueue = await client.fetch(`/backlog/${created.item.id}/analyze`, { method: "POST", body: "{}" });
    assert.equal(enqueue.status, 202);
    assert.equal(engine.calls.length, 0, "the API process ran no model");
    const queuedDetail = (await (await client.fetch(`/backlog/${created.item.id}`)).json()) as { item: { status: string }; analysisJob: { status: string } };
    assert.deepEqual([queuedDetail.item.status, queuedDetail.analysisJob.status], ["ANALYZING", "QUEUED"]);

    await workerPlatform.backlogRunner.drain(); // the worker process's poll cycle

    assert.equal(engine.calls.length, 1);
    const done = (await (await client.fetch(`/backlog/${created.item.id}`)).json()) as { item: { status: string }; analysisJob: { status: string; attemptCount: number }; latestAnalysis: { result: { summary: string } } };
    assert.equal(done.item.status, "ANALYZED");
    assert.equal(done.analysisJob.status, "SUCCEEDED");
    assert.equal(done.analysisJob.attemptCount, 1);
    assert.equal(done.latestAnalysis.result.summary, "analysed on the worker");
  } finally {
    await workerPlatform.backlogRunner.stop();
    workerPlatform.db.close();
    await new Promise((resolve) => server.close(resolve));
    platform.db.close();
  }
});
