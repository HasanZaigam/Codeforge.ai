import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovedClaimCheck } from "../src/domain/types.js";
import { fakeStructure, json, setupBacklogHarness, validAnalysis, type BacklogHarness } from "./helpers/backlog-harness.js";

/**
 * Phase 4A.6 — claim-bound verification runs as a durable WORKER JOB. These tests drive the same
 * ClaimVerifier.request → ClaimVerificationRunner path production uses, against a REAL git repository and a REAL check process,
 * and prove the failure paths: a job that fails, times out, is cancelled, loses its worker, is stale, mis-bound or unauthorized
 * can NEVER produce a verified claim.
 */

const run = promisify(execFile);

const CHECK: ApprovedClaimCheck = {
  id: "otp-throttle",
  description: "OTP send throttling",
  command: "node throttle-check.js",
  timeoutMs: 20_000,
  requiresFiles: ["throttle.js"],
  establishes: { scope: { level: "flow", application: "backend", mechanism: "evaluateOtpThrottle", entryPoint: "POST /login", behaviors: [{ id: "throttle", terms: ["limit", "limits", "limited", "limiting", "unlimited", "throttle", "throttles", "throttled", "rate", "cooldown", "cap"] }] }, behavior: "OTP sends are throttled", claimTerms: [["otp"], ["limit", "throttle", "rate", "cooldown"]], claimKinds: ["BEHAVIOR_CORRECT", "BEHAVIOR_INCORRECT"] },
  passMeans: "behavior_holds",
};

async function makeRepo(opts: { broken?: boolean; sleep?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cvw-"));
  const git = (...a: string[]) => run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  await writeFile(join(dir, "throttle.js"), `exports.allowed = (sends) => ${opts.broken ? "true" : "sends < 3"};\n`);
  await writeFile(
    join(dir, "throttle-check.js"),
    `const t = require("./throttle.js");\nrequire("fs").appendFileSync("ran.txt", "x\\n");\n${opts.sleep ? "setTimeout(() => {}, 60000);\n" : ""}if (!t.allowed(0) || !t.allowed(2) || t.allowed(3)) { console.error("throttle broken"); process.exit(1); }\nconsole.log("throttle ok");\n${opts.sleep ? "" : ""}`,
  );
  await git("init", "-b", "main");
  await git("add", "-A");
  await git("commit", "-m", "one");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  return { dir, sha, git, ran: () => (existsSync(join(dir, "ran.txt")) ? readFileSync(join(dir, "ran.txt"), "utf8").trim().split("\n").length : 0) };
}

type Repo = Awaited<ReturnType<typeof makeRepo>>;

async function scenario(label: string, opts: { repo?: { broken?: boolean; sleep?: boolean }; timeoutMs?: number; leaseMs?: number; heartbeatMs?: number; maxAttempts?: number; retryBaseDelayMs?: number; check?: ApprovedClaimCheck } = {}) {
  const repo = await makeRepo(opts.repo);
  const calls = { workspaces: 0, failNext: 0 };
  const h = await setupBacklogHarness(label, {
    structure: fakeStructure({ "throttle.js": "x", "throttle-check.js": "y" }, { revision: repo.sha }),
    respond: () => json(validAnalysis({ claims: [{ statement: "OTP attempts are not limited on POST /login.", kind: "BEHAVIOR_INCORRECT", path: null, searchTerms: ["otp", "limit"], confidence: "high" }], candidateFiles: [] })),
    platform: {
      verification: {
        checkTimeoutMsOverride: opts.timeoutMs,
        leaseMs: opts.leaseMs,
        heartbeatMs: opts.heartbeatMs,
        retryBaseDelayMs: opts.retryBaseDelayMs ?? 1,
        workspaceFactory: async () => {
          calls.workspaces++;
          if (calls.failNext > 0) {
            calls.failNext--;
            throw new Error("clone failed: network unreachable");
          }
          const head = (await repo.git("rev-parse", "HEAD")).stdout.trim();
          return { dir: repo.dir, head, dispose: async () => {} };
        },
      },
    },
  });
  h.platform.projects.updateCommands(h.project.id, { claimChecks: [opts.check ?? CHECK] }, new Date().toISOString());
  const item = h.item("No limit on OTP attempts", "BUG-073", "There is no limit on OTP attempts during login.");
  await h.analyze(item.id);
  const request = (actor = h.owner.id) => h.services.claimVerifier.request(item.id, actor);
  const jobs = () => h.services.claimVerifier.list(item.id, h.owner.id);
  const records = () => h.platform.claimVerifications.listForAnalysis(h.platform.backlogAnalyses.findLatestSucceededForItem(item.id)!.id);
  const review = () => h.services.backlog.getItem(item.id, h.owner.id).review;
  return { h, repo, item, calls, request, jobs, records, review, close: async () => { await h.platform.backgroundRunner.stop(); h.close(); } };
}

/** Simulates a worker that claimed the job and died: RUNNING, one attempt consumed, lease long expired. */
function killWorker(h: BacklogHarness, at: Date) {
  h.platform.db.prepare("UPDATE claim_verification_jobs SET status = 'RUNNING', claim_owner = 'dead-worker', lock_generation = 1, attempt_count = 1, started_at = ?, lease_expires_at = ?").run(at.toISOString(), new Date(at.getTime() + 1000).toISOString());
  return h.platform.claimVerificationJobs.findById((h.platform.db.prepare("SELECT id FROM claim_verification_jobs").get() as { id: string }).id);
}

const never = (r: { behavior: string }) => assert.notEqual(r.behavior, "CHECK_VERIFIED");

test("PASS: enqueue → worker claims → workspace at the exact revision → approved check → record bound to job → CHECK_VERIFIED; every relationship is recorded", async () => {
  const s = await scenario("cvw-pass");
  try {
    const queued = s.request();
    assert.equal(queued.jobs.length, 1);
    assert.equal(queued.jobs[0]!.status, "QUEUED");
    assert.equal(s.repo.ran(), 0, "the API-side request executes nothing");
    await s.h.platform.claimVerificationRunner.drain();
    const job = s.jobs()[0]!;
    assert.equal(job.status, "SUCCEEDED");
    assert.equal(job.revision, s.repo.sha);
    const rec = s.records()[0]!;
    assert.equal(rec.state, "passed");
    assert.equal(rec.jobId, job.id);
    assert.equal(rec.claimId, job.claimId);
    assert.equal(rec.checkId, "otp-throttle");
    assert.equal(rec.revision, s.repo.sha);
    assert.equal(rec.headBefore, s.repo.sha);
    assert.equal(rec.headAfter, s.repo.sha);
    assert.match(rec.executor!, /claim-verifier/);
    assert.ok(rec.startedAt && rec.completedAt && rec.workspaceId);
    assert.equal(rec.timedOut, false);
    assert.equal(s.review().behavior, "CHECK_VERIFIED");
    assert.equal(s.repo.ran(), 1);
  } finally { await s.close(); }
});

test("idempotent: requesting twice (and racing runners) creates ONE job and executes the check ONCE", async () => {
  const s = await scenario("cvw-idem");
  try {
    const a = s.request();
    const b = s.request();
    assert.equal(a.jobs[0]!.id, b.jobs[0]!.id);
    assert.equal(b.enqueued, 0);
    await Promise.all([s.h.platform.claimVerificationRunner.drain(), s.h.platform.claimVerificationRunner.drain()]);
    assert.equal(s.repo.ran(), 1, "no double execution");
    assert.equal(s.records().length, 1);
  } finally { await s.close(); }
});

test("double-claim: a second worker identity cannot claim a job another worker holds, and a stale owner's write is fenced out", async () => {
  const s = await scenario("cvw-claim");
  try {
    s.request();
    const jobs = s.h.platform.claimVerificationJobs;
    const t = new Date();
    const first = jobs.claimNext("worker-A", t.toISOString(), new Date(t.getTime() + 60_000).toISOString(), 5)!;
    assert.ok(first);
    assert.equal(jobs.claimNext("worker-B", t.toISOString(), new Date(t.getTime() + 60_000).toISOString(), 5), null);
    // A lease that lapsed lets B take over; A's late finish is then rejected.
    const later = new Date(t.getTime() + 120_000);
    const second = jobs.claimNext("worker-B", later.toISOString(), new Date(later.getTime() + 60_000).toISOString(), 5)!;
    assert.ok(second);
    assert.equal(second.lockGeneration, first.lockGeneration + 1);
    assert.equal(jobs.finish({ id: first.id, owner: "worker-A", generation: first.lockGeneration }, "SUCCEEDED", null, later.toISOString()), false);
    assert.equal(jobs.findById(first.id)!.status, "RUNNING");
  } finally { await s.close(); }
});

test("FAIL: a check that really fails is a FAILED job and a 'failed' record — never verified", async () => {
  const s = await scenario("cvw-fail", { repo: { broken: true } });
  try {
    s.request();
    await s.h.platform.claimVerificationRunner.drain();
    assert.equal(s.jobs()[0]!.status, "FAILED");
    assert.equal(s.records()[0]!.state, "failed");
    assert.equal(s.repo.ran(), 1);
    never(s.review());
  } finally { await s.close(); }
});

test("TIMEOUT: a check that exceeds its timeout is a TIMED_OUT job, timed_out recorded, never verified", async () => {
  const s = await scenario("cvw-timeout", { repo: { sleep: true }, timeoutMs: 400 });
  try {
    s.request();
    await s.h.platform.claimVerificationRunner.drain();
    assert.equal(s.jobs()[0]!.status, "TIMED_OUT");
    assert.equal(s.records()[0]!.state, "timed_out");
    assert.equal(s.records()[0]!.timedOut, true);
    never(s.review());
  } finally { await s.close(); }
});

test("CANCEL: a queued job is cancelled at once; a RUNNING job is stopped at the next heartbeat, records nothing and verifies nothing", async () => {
  const q = await scenario("cvw-cancel-q");
  try {
    const job = q.request().jobs[0]!;
    assert.equal(q.h.services.claimVerifier.cancel(q.item.id, job.id, q.h.owner.id).status, "CANCELLED");
    await q.h.platform.claimVerificationRunner.drain();
    assert.equal(q.repo.ran(), 0);
    assert.equal(q.records().length, 0);
  } finally { await q.close(); }

  const r = await scenario("cvw-cancel-r", { repo: { sleep: true }, heartbeatMs: 25, timeoutMs: 30_000 });
  try {
    const job = r.request().jobs[0]!;
    const runner = r.h.platform.claimVerificationRunner;
    await runner.tick();
    assert.equal(r.jobs()[0]!.status, "RUNNING");
    await new Promise((res) => setTimeout(res, 300)); // let the check start
    assert.equal(r.h.services.claimVerifier.cancel(r.item.id, job.id, r.h.owner.id).cancelRequestedAt !== null, true);
    await runner.idle();
    assert.equal(r.jobs()[0]!.status, "CANCELLED");
    assert.equal(r.records().length, 0, "a cancelled run records no verdict");
    never(r.review());
  } finally { await r.close(); }
});

test("CRASH RECOVERY: a job whose worker died (lease expired, attempts left) is re-claimed and completes; one out of attempts is settled FAILED without running", async () => {
  const s = await scenario("cvw-crash");
  try {
    s.request();
    const past = new Date(Date.now() - 600_000);
    const dead = killWorker(s.h, past)!;
    assert.equal(dead.attemptCount, 1);
    await s.h.platform.claimVerificationRunner.drain();
    const job = s.jobs()[0]!;
    assert.equal(job.status, "SUCCEEDED");
    assert.equal(job.attemptCount, 2);
    assert.equal(s.repo.ran(), 1);
  } finally { await s.close(); }

  const x = await scenario("cvw-crash-x");
  try {
    x.request();
    x.h.platform.db.prepare("UPDATE claim_verification_jobs SET max_attempts = 1").run();
    killWorker(x.h, new Date(Date.now() - 600_000));
    await x.h.platform.claimVerificationRunner.drain();
    assert.equal(x.jobs()[0]!.status, "FAILED");
    assert.match(x.jobs()[0]!.failureReason!, /lost/);
    assert.equal(x.repo.ran(), 0);
    assert.equal(x.records().length, 0);
  } finally { await x.close(); }
});

test("RETRY: an infrastructure error (workspace cannot be prepared) is retried with backoff, then FAILED when attempts run out — never a verdict", async () => {
  const s = await scenario("cvw-retry", { retryBaseDelayMs: 60_000 });
  try {
    s.calls.failNext = 1;
    s.request();
    await s.h.platform.claimVerificationRunner.drain();
    assert.equal(s.jobs()[0]!.status, "QUEUED", "requeued with a backoff, not failed");
    assert.ok(new Date(s.jobs()[0]!.availableAt).getTime() > Date.now() + 30_000, "the backoff is real");
    assert.equal(s.repo.ran(), 0);
    s.h.platform.db.prepare("UPDATE claim_verification_jobs SET available_at = ?").run(new Date().toISOString()); // the backoff elapses (deterministically, not by sleeping)
    await s.h.platform.claimVerificationRunner.drain();
    assert.equal(s.jobs()[0]!.status, "SUCCEEDED", "the second attempt succeeded");
    assert.equal(s.jobs()[0]!.attemptCount, 2);
  } finally { await s.close(); }
  const t = await scenario("cvw-retry-x");
  try {
    t.calls.failNext = 5;
    t.request();
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 10)); await t.h.platform.claimVerificationRunner.drain(); }
    assert.equal(t.jobs()[0]!.status, "FAILED");
    assert.match(t.jobs()[0]!.failureReason!, /no attempts left/);
    assert.equal(t.records().length, 0);
    assert.equal(t.repo.ran(), 0);
  } finally { await t.close(); }
});

test("REVISION INTEGRITY: a workspace that is not at the analysed revision, or a job for another revision, runs NOTHING", async () => {
  const s = await scenario("cvw-rev");
  try {
    await writeFile(join(s.repo.dir, "later.txt"), "later\n");
    await s.repo.git("add", "-A");
    await s.repo.git("commit", "-m", "later");
    s.request();
    await s.h.platform.claimVerificationRunner.drain();
    assert.equal(s.repo.ran(), 0, "HEAD moved on: the check did not run");
    assert.equal(s.records()[0]!.state, "rejected");
    assert.equal(s.jobs()[0]!.status, "FAILED");
    never(s.review());
  } finally { await s.close(); }

  const t = await scenario("cvw-rev-b");
  try {
    t.request();
    t.h.platform.db.prepare("UPDATE claim_verification_jobs SET revision = ?").run("b".repeat(40));
    await t.h.platform.claimVerificationRunner.drain();
    assert.equal(t.calls.workspaces, 0, "no workspace was even prepared");
    assert.equal(t.jobs()[0]!.status, "FAILED");
    assert.match(t.jobs()[0]!.failureReason!, /revision/);
    assert.equal(t.records().length, 0);
  } finally { await t.close(); }
});

test("INVALID BINDING: an edited check, a swapped claim id, a superseded analysis and a lost owner all refuse before anything runs", async () => {
  const edited = await scenario("cvw-bind-check");
  try {
    edited.request();
    edited.h.platform.projects.updateCommands(edited.h.project.id, { claimChecks: [{ ...CHECK, command: "node throttle-check.js && echo changed" }] }, new Date().toISOString());
    await edited.h.platform.claimVerificationRunner.drain();
    assert.match(edited.jobs()[0]!.failureReason!, /check changed/);
    assert.equal(edited.repo.ran(), 0);
  } finally { await edited.close(); }

  const claimSwap = await scenario("cvw-bind-claim");
  try {
    claimSwap.request();
    claimSwap.h.platform.db.prepare("UPDATE claim_verification_jobs SET claim_id = 'deadbeef'").run();
    await claimSwap.h.platform.claimVerificationRunner.drain();
    assert.match(claimSwap.jobs()[0]!.failureReason!, /no longer bound/);
    assert.equal(claimSwap.repo.ran(), 0);
  } finally { await claimSwap.close(); }

  const superseded = await scenario("cvw-bind-super");
  try {
    superseded.request();
    await superseded.h.analyze(superseded.item.id);
    await superseded.h.platform.claimVerificationRunner.drain();
    assert.match(superseded.jobs()[0]!.failureReason!, /superseded/);
    assert.equal(superseded.repo.ran(), 0);
    assert.equal(superseded.records().length, 0);
  } finally { await superseded.close(); }

  const owner = await scenario("cvw-bind-owner");
  try {
    owner.request();
    const other = owner.h.addUser("new-owner");
    owner.h.platform.db.prepare("UPDATE projects SET owner_id = ?").run(other.id);
    await owner.h.platform.claimVerificationRunner.drain();
    const row = owner.h.platform.db.prepare("SELECT status, failure_reason FROM claim_verification_jobs").get() as { status: string; failure_reason: string };
    assert.equal(row.status, "FAILED");
    assert.match(row.failure_reason, /no longer has access/);
    assert.equal(owner.repo.ran(), 0);
  } finally { await owner.close(); }
});

test("AUTHORIZATION: only the project owner can request, list or cancel; an unbound project has nothing to enqueue", async () => {
  const s = await scenario("cvw-auth");
  try {
    const other = s.h.addUser("intruder");
    assert.throws(() => s.request(other.id), /not found/i);
    const job = s.request().jobs[0]!;
    assert.throws(() => s.h.services.claimVerifier.list(s.item.id, other.id), /not found/i);
    assert.throws(() => s.h.services.claimVerifier.cancel(s.item.id, job.id, other.id), /not found/i);
    assert.equal(s.jobs()[0]!.status, "QUEUED");
    // No approved check ⇒ nothing queued.
    s.h.platform.projects.updateCommands(s.h.project.id, { claimChecks: [] }, new Date().toISOString());
    const none = s.request();
    assert.equal(none.jobs.length, 0);
    assert.match(none.note!, /nothing was queued/);
  } finally { await s.close(); }
});

test("A finished job cannot be cancelled; graceful shutdown returns a running job to the queue with its attempt given back", async () => {
  const s = await scenario("cvw-stop", { repo: { sleep: true }, heartbeatMs: 25, timeoutMs: 30_000 });
  try {
    const job = s.request().jobs[0]!;
    await s.h.platform.claimVerificationRunner.tick();
    await new Promise((r) => setTimeout(r, 300));
    await s.h.platform.claimVerificationRunner.stop();
    const after = s.jobs()[0]!;
    assert.equal(after.status, "QUEUED");
    assert.equal(after.attemptCount, 0);
    assert.equal(s.records().length, 0);
    void job;
  } finally { await s.close(); }
});

test("MUTATION-FOUND GAPS: a job bound to another item's analysis, a cancel left by a dead worker, and a lost claim are all handled", async () => {
  // A job whose analysis belongs to ANOTHER item refuses before anything runs.
  const a = await scenario("cvw-mut-item");
  try {
    a.request();
    const other = a.h.item("Another item", "OTHER-1", "Something else entirely about videos.");
    await a.h.analyze(other.id);
    const otherAnalysis = a.h.platform.backlogAnalyses.findLatestSucceededForItem(other.id)!;
    a.h.platform.db.prepare("UPDATE claim_verification_jobs SET analysis_id = ?").run(otherAnalysis.id);
    await a.h.platform.claimVerificationRunner.drain();
    assert.equal(a.jobs()[0]!.status, "FAILED");
    assert.equal(a.repo.ran(), 0);
    assert.equal(a.records().length, 0);
  } finally { await a.close(); }

  // A worker died after a cancel was requested: whoever reclaims the job settles it CANCELLED without running anything.
  const c = await scenario("cvw-mut-cancel");
  try {
    c.request();
    killWorker(c.h, new Date(Date.now() - 600_000));
    c.h.platform.db.prepare("UPDATE claim_verification_jobs SET cancel_requested_at = ?").run(new Date().toISOString());
    await c.h.platform.claimVerificationRunner.drain();
    assert.equal(c.jobs()[0]!.status, "CANCELLED");
    assert.equal(c.repo.ran(), 0);
  } finally { await c.close(); }

  // A lease lost to another worker mid-run: the old worker aborts and records NOTHING; the new owner keeps the job.
  const l = await scenario("cvw-mut-lost", { repo: { sleep: true }, heartbeatMs: 25, timeoutMs: 30_000 });
  try {
    l.request();
    await l.h.platform.claimVerificationRunner.tick();
    await new Promise((r) => setTimeout(r, 300));
    l.h.platform.db.prepare("UPDATE claim_verification_jobs SET claim_owner = 'thief', lock_generation = lock_generation + 1").run();
    await l.h.platform.claimVerificationRunner.idle();
    const row = l.h.platform.db.prepare("SELECT status, claim_owner FROM claim_verification_jobs").get() as { status: string; claim_owner: string };
    assert.deepEqual([row.status, row.claim_owner], ["RUNNING", "thief"], "the stale worker wrote nothing");
    assert.equal(l.records().length, 0);
  } finally { await l.close(); }
});

test("MUTATION-FOUND GAPS: repository guards — the cap is enforced in the claim itself, exhausted jobs are never re-claimed, and results are redacted and bounded", async () => {
  const s = await scenario("cvw-mut-repo");
  try {
    s.request();
    const jobs = s.h.platform.claimVerificationJobs;
    const now = new Date();
    const later = new Date(now.getTime() + 60_000).toISOString();
    // The cap lives in the guarded UPDATE, not only in the cheap early exit: a stale count (another process claimed in between) cannot over-claim.
    const other = s.h.platform.db.prepare("SELECT id FROM claim_verification_jobs").get() as { id: string };
    s.h.platform.db.prepare("UPDATE claim_verification_jobs SET status = 'RUNNING', claim_owner = 'w1', lock_generation = 1, attempt_count = 1, lease_expires_at = ? WHERE id = ?").run(later, other.id);
    s.h.platform.db.prepare("INSERT INTO claim_verification_jobs SELECT lower(hex(randomblob(16))), backlog_item_id, project_id, analysis_id, claim_id, claim_index, 'other-check', check_fingerprint, revision, 'QUEUED', requested_by, 0, max_attempts, available_at, NULL, NULL, 0, NULL, NULL, created_at, NULL, NULL, updated_at FROM claim_verification_jobs").run();
    const real = jobs.countRunning.bind(jobs);
    jobs.countRunning = () => 0; // stale early-exit
    assert.equal(jobs.claimNext("w2", now.toISOString(), later, 1), null);
    jobs.countRunning = real;
    // An expired-lease job with NO attempts left is an orphan, never claimable again.
    s.h.platform.db.prepare("UPDATE claim_verification_jobs SET status = 'RUNNING', lease_expires_at = ?, attempt_count = max_attempts, claim_owner = 'dead' WHERE id = ?").run(new Date(now.getTime() - 1000).toISOString(), other.id);
    s.h.platform.db.prepare("UPDATE claim_verification_jobs SET status = 'CANCELLED' WHERE id != ?").run(other.id);
    assert.equal(jobs.claimNext("w3", now.toISOString(), later, 5), null);
    assert.deepEqual(jobs.listOrphans(now.toISOString()).map((j) => j.id), [other.id]);
    // …and a healthy expired job (attempts left) is NOT an orphan.
    s.h.platform.db.prepare("UPDATE claim_verification_jobs SET attempt_count = 0 WHERE id = ?").run(other.id);
    assert.deepEqual(jobs.listOrphans(now.toISOString()), []);
  } finally { await s.close(); }
});

test("MUTATION-FOUND GAPS: cancel is scoped to the item's own job, a finished job cannot be cancelled, and check output is redacted and bounded", async () => {
  const s = await scenario("cvw-mut-svc");
  try {
    const job = s.request().jobs[0]!;
    // Another user's own item cannot be used to cancel this job.
    const intruder = s.h.addUser("intruder2");
    const foreign = s.h.platform.backlogItems.findById(s.item.id)!;
    void foreign;
    const project2 = await s.h.services.projects.create({ name: "P2", sourceControlProvider: "local-git", repoUrl: s.repo.dir, codingEngine: "fixture" }, intruder.id);
    const item2 = s.h.services.backlog.createItem(project2.id, { title: "mine", description: "mine" }, intruder.id);
    assert.throws(() => s.h.services.claimVerifier.cancel(item2.id, job.id, intruder.id), /not found/i);
    assert.equal(s.jobs()[0]!.status, "QUEUED", "the foreign cancel changed nothing");
    await s.h.platform.claimVerificationRunner.drain();
    assert.equal(s.jobs()[0]!.status, "SUCCEEDED");
    assert.throws(() => s.h.services.claimVerifier.cancel(s.item.id, job.id, s.h.owner.id), /already finished/);
  } finally { await s.close(); }

  process.env.CVW_TEST_TOKEN = "SECRETVALUE12345";
  const noisy: ApprovedClaimCheck = { ...CHECK, command: `node -e "console.log('x'.repeat(5000) + ' SECRETVALUE12345')"` };
  const r = await scenario("cvw-mut-redact", { check: noisy });
  try {
    r.request();
    await r.h.platform.claimVerificationRunner.drain();
    const log = r.records()[0]!.logExcerpt!;
    assert.doesNotMatch(log, /SECRETVALUE12345/);
    assert.ok(log.length <= 2000, "bounded");
  } finally {
    delete process.env.CVW_TEST_TOKEN;
    await r.close();
  }
});

void (null as unknown as BacklogHarness);
void (null as unknown as Repo);
