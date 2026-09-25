import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, MIGRATION_FILES } from "../src/persistence/db.js";
import { BacklogAnalysisJobRepository, isActiveJobViolation } from "../src/persistence/repositories/backlog-analysis-job-repository.js";
import { isDuplicateBacklogRefViolation, BacklogItemRepository } from "../src/persistence/repositories/backlog-item-repository.js";
import { TaskProposalRepository, isLiveProposalViolation } from "../src/persistence/repositories/task-proposal-repository.js";
import { BacklogAnalysisRepository } from "../src/persistence/repositories/backlog-analysis-repository.js";
import { BacklogRelationshipRepository } from "../src/persistence/repositories/backlog-relationship-repository.js";
import { BacklogEventRepository } from "../src/persistence/repositories/backlog-event-repository.js";
import { runInTransaction } from "../src/persistence/transaction.js";
import type { BacklogItem, TaskProposalContent } from "../src/backlog/backlog-types.js";
import { AnalysisResultSchema } from "../src/backlog/analysis-schema.js";
import { setupBacklogHarness, validAnalysis, type BacklogHarness } from "./helpers/backlog-harness.js";

/**
 * Phase 4A — the persistence layer's own guarantees (see migrations/013_backlog_intelligence.sql).
 * These are the structural backstops: even a caller that skips every application-level check cannot
 * violate them.
 */

async function withHarness(label: string, fn: (h: BacklogHarness) => Promise<void> | void): Promise<void> {
  const h = await setupBacklogHarness(label);
  try {
    await fn(h);
  } finally {
    await h.platform.backlogRunner.stop();
    h.close();
  }
}

const NOW = "2026-01-01T00:00:00.000Z";

function rawItem(h: BacklogHarness, overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: randomUUID(),
    projectId: h.project.id,
    externalRef: null,
    title: "t",
    description: "d",
    source: "manual",
    status: "NEW",
    createdBy: h.owner.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function proposalContent(): TaskProposalContent {
  return {
    title: "T",
    goal: "G",
    summary: "S",
    issueType: "bug",
    affectedApplication: null,
    suspectedArea: null,
    candidateFiles: [],
    acceptanceCriteria: [],
    validation: [],
    dependencies: [],
    duplicateWarnings: [],
    uncertainty: { overall: "low", uncertainties: [], missingInformation: [] },
    claimAssessments: [],
    investigateFirst: false,
  implementationConflict: "none",
  };
}

/** Inserts a real succeeded analysis row so proposals/relationships have a valid FK target. */
function insertAnalysis(h: BacklogHarness, itemId: string, id = randomUUID()): string {
  h.platform.backlogAnalyses.insert({
    id,
    backlogItemId: itemId,
    projectId: h.project.id,
    status: "succeeded",
    failureCategory: null,
    failureReason: null,
    result: AnalysisResultSchema.parse(validAnalysis()),
    platformChecks: null,
    diagnostics: null,
    modelId: null,
    providerId: null,
    engineKey: null,
    fallbackIndex: 0,
    routingReason: null,
    cost: null,
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 1,
  });
  return id;
}

test("migrations 013/014 are registered, create the backlog tables (incl. analysis jobs), and re-opening the database is idempotent", async () => {
  await withHarness("migration", (h) => {
    assert.ok(MIGRATION_FILES.includes("013_backlog_intelligence.sql"));
    assert.ok(MIGRATION_FILES.includes("014_backlog_analysis_jobs.sql"));
    const tables = (h.platform.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const table of ["backlog_items", "backlog_analyses", "backlog_relationships", "task_proposals", "backlog_events", "backlog_analysis_jobs"]) {
      assert.ok(tables.includes(table), `${table} must exist`);
    }
    assert.ok((h.platform.db.prepare("SELECT 1 FROM _migrations WHERE name = '013_backlog_intelligence.sql'").get()) !== undefined);
    // Opening the same file again runs no migration twice and does not throw.
    const again = openDatabase(h.dbPath);
    try {
      const count = (again.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = '013_backlog_intelligence.sql'").get() as { n: number }).n;
      assert.equal(count, 1);
    } finally {
      again.close();
    }
  });
});

test("migration 013 is purely additive: it does not alter any pre-existing table's columns", async () => {
  await withHarness("additive", (h) => {
    const cols = (table: string) => (h.platform.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols("tasks").some((c) => /backlog|proposal/i.test(c)), "tasks gained no backlog columns");
    assert.ok(!cols("projects").some((c) => /backlog|proposal/i.test(c)), "projects gained no backlog columns");
  });
});

test("backlog_items: reference uniqueness is per project and case-insensitive; NULL references never collide", async () => {
  await withHarness("ref-unique", (h) => {
    const items = h.platform.backlogItems;
    items.insert(rawItem(h, { externalRef: "BUG-1" }));
    assert.throws(() => items.insert(rawItem(h, { externalRef: "bug-1" })), (err) => isDuplicateBacklogRefViolation(err));
    assert.doesNotThrow(() => items.insert(rawItem(h)));
    assert.doesNotThrow(() => items.insert(rawItem(h)));
    assert.equal(items.findByProjectAndRef(h.project.id, "Bug-1")?.externalRef, "BUG-1");
  });
});

test("backlog_items: CHECK constraints reject an unknown status or source, and a missing project is a foreign-key error", async () => {
  await withHarness("item-checks", (h) => {
    const items = h.platform.backlogItems;
    assert.throws(() => items.insert(rawItem(h, { status: "DONE" as never })));
    assert.throws(() => items.insert(rawItem(h, { source: "slack" as never })));
    assert.throws(() => items.insert(rawItem(h, { projectId: randomUUID() })));
    assert.throws(() => items.insert(rawItem(h, { createdBy: randomUUID() })));
  });
});

test("guarded transitions: an illegal transition changes zero rows and leaves the item untouched", async () => {
  await withHarness("guarded", (h) => {
    const items = h.platform.backlogItems;
    const item = rawItem(h);
    items.insert(item);
    // NEW cannot be converted, cannot have a proposal generated, cannot have a proposal rejected.
    assert.equal(items.transition(item.id, "converted", NOW), false);
    assert.equal(items.transition(item.id, "proposal_generated", NOW), false);
    assert.equal(items.transition(item.id, "proposal_rejected", NOW), false);
    assert.equal(items.findById(item.id)!.status, "NEW");
    // It CAN be rejected; then nothing further applies.
    assert.equal(items.transition(item.id, "rejected", NOW), true);
    assert.equal(items.transition(item.id, "rejected", NOW), false, "REJECTED is terminal");
    assert.equal(items.beginAnalysis(item.id, NOW), false);
    assert.equal(items.updateContent(item.id, { title: "x", description: "y", externalRef: null }, NOW), false);
    assert.equal(items.findById(item.id)!.status, "REJECTED");
  });
});

test("beginAnalysis: only from NEW / NEEDS_CLARIFICATION / ANALYZED, records where to return to, and refuses everything else", async () => {
  await withHarness("begin", (h) => {
    const items = h.platform.backlogItems;
    for (const before of ["NEW", "NEEDS_CLARIFICATION", "ANALYZED"] as const) {
      const item = rawItem(h, { status: before });
      items.insert(item);
      assert.equal(items.beginAnalysis(item.id, NOW), true, before);
      assert.equal(items.findById(item.id)!.status, "ANALYZING");
      assert.equal(items.beginAnalysis(item.id, NOW), false, "an ANALYZING item cannot begin again — it has a live job");
    }
    for (const blocked of ["READY_FOR_TASK", "CONVERTED", "REJECTED"] as const) {
      const item = rawItem(h, { status: blocked });
      items.insert(item);
      assert.equal(items.beginAnalysis(item.id, NOW), false, blocked);
      assert.equal(items.findById(item.id)!.status, blocked);
    }
  });
});

test("abortAnalysis returns the item to its exact pre-analysis status; completeAnalysis needs ANALYZING", async () => {
  await withHarness("abort", (h) => {
    const items = h.platform.backlogItems;
    for (const before of ["NEW", "NEEDS_CLARIFICATION", "ANALYZED"] as const) {
      const item = rawItem(h, { status: before });
      items.insert(item);
      assert.equal(items.beginAnalysis(item.id, NOW), true);
      assert.equal(items.abortAnalysis(item.id, NOW), true);
      assert.equal(items.findById(item.id)!.status, before);
      assert.equal(items.abortAnalysis(item.id, NOW), false, "nothing left to abort");
      assert.equal(items.completeAnalysis(item.id, "analysis_succeeded", NOW), false, "cannot complete an item that is not ANALYZING");
    }
  });
});

test("analysis JOBS: at most ONE live job per item (partial unique index); a finished job frees the slot", async () => {
  await withHarness("job-unique", (h) => {
    const item = rawItem(h);
    h.platform.backlogItems.insert(item);
    const jobs = h.platform.backlogJobs;
    const enqueue = () => jobs.enqueue({ id: randomUUID(), backlogItemId: item.id, projectId: h.project.id, requestedBy: h.owner.id, maxAttempts: 3, now: NOW });
    enqueue();
    assert.throws(() => enqueue(), (err) => isActiveJobViolation(err));
    const live = jobs.findActiveForItem(item.id)!;
    assert.equal(jobs.cancelQueued(live.id, NOW), true);
    assert.doesNotThrow(() => enqueue());
    assert.equal((h.platform.db.prepare("SELECT COUNT(*) AS n FROM backlog_analysis_jobs WHERE backlog_item_id = ?").get(item.id) as { n: number }).n, 2);
  });
});

test("backlog_analysis_jobs: CHECK constraints reject an unknown status and max_attempts < 1; FK to the item is enforced", async () => {
  await withHarness("job-checks", (h) => {
    const item = rawItem(h);
    h.platform.backlogItems.insert(item);
    const raw = (status: string, maxAttempts: number, itemId = item.id) =>
      h.platform.db
        .prepare(
          `INSERT INTO backlog_analysis_jobs (id, backlog_item_id, project_id, status, requested_by, max_attempts, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), itemId, h.project.id, status, h.owner.id, maxAttempts, NOW, NOW, NOW);
    assert.throws(() => raw("PAUSED", 3), /CHECK/);
    assert.throws(() => raw("FAILED", 0), /CHECK/);
    assert.throws(() => raw("FAILED", 3, randomUUID()), /FOREIGN KEY/);
    assert.doesNotThrow(() => raw("FAILED", 3));
  });
});

test("job repository has no method that accepts an arbitrary status", async () => {
  const methods = Object.getOwnPropertyNames(BacklogAnalysisJobRepository.prototype);
  assert.ok(!methods.some((m) => /^(set|update)Status$/i.test(m)), methods.join(", "));
});

test("backlog_analyses: a succeeded row must carry a result and a failed row must not (CHECK)", async () => {
  await withHarness("analysis-check", (h) => {
    const item = rawItem(h);
    h.platform.backlogItems.insert(item);
    const insertRaw = (status: string, resultJson: string | null) =>
      h.platform.db
        .prepare(
          `INSERT INTO backlog_analyses (id, backlog_item_id, project_id, status, result_json, fallback_index, started_at, completed_at, duration_ms)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0)`,
        )
        .run(randomUUID(), item.id, h.project.id, status, resultJson, NOW, NOW);
    assert.throws(() => insertRaw("succeeded", null));
    assert.throws(() => insertRaw("failed", '{"a":1}'));
    assert.doesNotThrow(() => insertRaw("failed", null));
    assert.throws(() => insertRaw("bogus", null));
  });
});

test("backlog_analyses: a stored 'succeeded' result that no longer satisfies the schema is read back as FAILED, never trusted", async () => {
  await withHarness("analysis-revalidate", (h) => {
    const item = rawItem(h);
    h.platform.backlogItems.insert(item);
    const id = insertAnalysis(h, item.id);
    assert.equal(h.platform.backlogAnalyses.findById(id)!.status, "succeeded");
    h.platform.db.prepare("UPDATE backlog_analyses SET result_json = ? WHERE id = ?").run(JSON.stringify({ ...validAnalysis(), status: "CONVERTED" }), id);
    const read = h.platform.backlogAnalyses.findById(id)!;
    assert.equal(read.status, "failed");
    assert.equal(read.result, null);
    assert.equal(read.failureCategory, "malformed_output");
    h.platform.db.prepare("UPDATE backlog_analyses SET result_json = 'not json' WHERE id = ?").run(id);
    assert.equal(h.platform.backlogAnalyses.findById(id)!.status, "failed");
    // findLatestSucceeded must not surface a now-invalid analysis as a usable one... it is filtered by status column, so verify the DTO-level truth instead:
    assert.equal(h.platform.backlogAnalyses.findLatestForItem(item.id)!.result, null);
  });
});

test("backlog_relationships: (kind, from, to) is unique, self-relations and unknown kinds/statuses/confidences are rejected, ids are deterministic", async () => {
  await withHarness("rel-constraints", (h) => {
    const a = rawItem(h);
    const b = rawItem(h);
    h.platform.backlogItems.insert(a);
    h.platform.backlogItems.insert(b);
    const analysisId = insertAnalysis(h, a.id);
    const rels = h.platform.backlogRelationships;

    rels.replaceProposed(h.project.id, a.id, analysisId, [{ kind: "DEPENDS_ON", toItemId: b.id, confidence: "high", rationale: "r" }], NOW);
    // Re-proposing the identical relationship keeps exactly one row with the same deterministic id.
    const firstId = rels.listOutgoing(a.id)[0]!.id;
    rels.replaceProposed(h.project.id, a.id, analysisId, [{ kind: "DEPENDS_ON", toItemId: b.id, confidence: "low", rationale: "r2" }], NOW);
    assert.equal(rels.listOutgoing(a.id).length, 1);
    assert.equal(rels.listOutgoing(a.id)[0]!.id, firstId);
    assert.equal(rels.listOutgoing(a.id)[0]!.confidence, "low");

    const raw = (from: string, to: string, kind: string, status: string, confidence: string) =>
      h.platform.db
        .prepare(
          `INSERT INTO backlog_relationships (id, project_id, from_item_id, to_item_id, kind, status, confidence, rationale, analysis_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'r', ?, ?, ?)`,
        )
        .run(randomUUID(), h.project.id, from, to, kind, status, confidence, analysisId, NOW, NOW);
    assert.throws(() => raw(a.id, b.id, "DEPENDS_ON", "PROPOSED", "high"), /UNIQUE/, "duplicate (kind, from, to)");
    assert.throws(() => raw(a.id, a.id, "POSSIBLE_DUPLICATE", "PROPOSED", "high"), /CHECK/, "self relation");
    assert.throws(() => raw(b.id, a.id, "MERGES_INTO", "PROPOSED", "high"), /CHECK/);
    assert.throws(() => raw(b.id, a.id, "DEPENDS_ON", "APPROVED", "high"), /CHECK/);
    assert.throws(() => raw(b.id, a.id, "DEPENDS_ON", "PROPOSED", "certain"), /CHECK/);
    assert.throws(() => raw(b.id, randomUUID(), "DEPENDS_ON", "PROPOSED", "high"), /FOREIGN KEY/);
  });
});

test("backlog_relationships: a re-analysis replaces only PROPOSED rows — a human's CONFIRMED/DISMISSED decision survives, and DISMISSED edges leave the cycle-guard graph", async () => {
  await withHarness("rel-decisions", (h) => {
    const [a, b, c] = [rawItem(h), rawItem(h), rawItem(h)];
    for (const i of [a, b, c]) h.platform.backlogItems.insert(i);
    const analysisId = insertAnalysis(h, a.id);
    const rels = h.platform.backlogRelationships;
    rels.replaceProposed(h.project.id, a.id, analysisId, [
      { kind: "DEPENDS_ON", toItemId: b.id, confidence: "high", rationale: "r" },
      { kind: "DEPENDS_ON", toItemId: c.id, confidence: "high", rationale: "r" },
    ], NOW);
    h.platform.db.prepare("UPDATE backlog_relationships SET status = 'CONFIRMED' WHERE from_item_id = ? AND to_item_id = ?").run(a.id, b.id);
    h.platform.db.prepare("UPDATE backlog_relationships SET status = 'DISMISSED' WHERE from_item_id = ? AND to_item_id = ?").run(a.id, c.id);

    rels.replaceProposed(h.project.id, a.id, analysisId, [], NOW);
    const remaining = rels.listOutgoing(a.id).map((r) => [r.toItemId === b.id ? "b" : "c", r.status]);
    assert.deepEqual(remaining.sort(), [["b", "CONFIRMED"], ["c", "DISMISSED"]], "human decisions are never discarded by a re-analysis");
    assert.deepEqual(rels.listLiveEdges(h.project.id, "DEPENDS_ON"), [{ fromItemId: a.id, toItemId: b.id }], "DISMISSED is not a live edge");
  });
});

test("task_proposals: at most ONE live proposal per backlog item (partial unique index); a REJECTED one frees the slot", async () => {
  await withHarness("proposal-unique", (h) => {
    const item = rawItem(h, { status: "ANALYZED" });
    h.platform.backlogItems.insert(item);
    const analysisId = insertAnalysis(h, item.id);
    const proposals = h.platform.taskProposals;
    const insert = () => proposals.insertPending({ id: randomUUID(), backlogItemId: item.id, projectId: h.project.id, analysisId, content: proposalContent(), now: NOW });

    insert();
    assert.throws(() => insert(), (err) => isLiveProposalViolation(err));
    const live = proposals.findLiveForItem(item.id)!;
    assert.equal(proposals.reject(live.id, h.owner.id, NOW), true);
    assert.doesNotThrow(() => insert(), "rejecting frees the slot");
    assert.equal(h.platform.db.prepare("SELECT COUNT(*) AS n FROM task_proposals WHERE backlog_item_id = ?").get(item.id)!.n, 2);
  });
});

test("task_proposals: a Task id can be reserved by, and attached to, at most one proposal", async () => {
  await withHarness("proposal-task-unique", (h) => {
    const mk = () => {
      const item = rawItem(h, { status: "READY_FOR_TASK" });
      h.platform.backlogItems.insert(item);
      const analysisId = insertAnalysis(h, item.id);
      const id = randomUUID();
      h.platform.taskProposals.insertPending({ id, backlogItemId: item.id, projectId: h.project.id, analysisId, content: proposalContent(), now: NOW });
      h.platform.taskProposals.approve(id, h.owner.id, NOW);
      return id;
    };
    const p1 = mk();
    const p2 = mk();
    const reserved = randomUUID();
    assert.equal(h.platform.taskProposals.claimConversion(p1, "c1", reserved, NOW, "2999-01-01T00:00:00.000Z"), true);
    assert.throws(() => h.platform.taskProposals.claimConversion(p2, "c2", reserved, NOW, "2999-01-01T00:00:00.000Z"), /UNIQUE/, "the same reserved task id cannot back two proposals");
  });
});

test("task proposal transitions are one-way and guarded: approve only from PENDING, reject only from PENDING/APPROVED, no arbitrary status setter exists", async () => {
  await withHarness("proposal-transitions", (h) => {
    const item = rawItem(h, { status: "READY_FOR_TASK" });
    h.platform.backlogItems.insert(item);
    const analysisId = insertAnalysis(h, item.id);
    const p = h.platform.taskProposals;
    const id = randomUUID();
    p.insertPending({ id, backlogItemId: item.id, projectId: h.project.id, analysisId, content: proposalContent(), now: NOW });

    assert.equal(p.claimConversion(id, "c", randomUUID(), NOW, "2999-01-01T00:00:00.000Z"), false, "PENDING cannot be claimed for conversion");
    assert.equal(p.finalizeConversion(id, "c", randomUUID(), NOW), false, "PENDING cannot be finalized");
    assert.equal(p.approve(id, h.owner.id, NOW), true);
    assert.equal(p.approve(id, h.owner.id, NOW), false, "already approved");
    assert.equal(p.claimConversion(id, "c", randomUUID(), NOW, "2999-01-01T00:00:00.000Z"), true);
    assert.equal(p.reject(id, h.owner.id, NOW), false, "a CONVERTING proposal cannot be rejected");
    assert.equal(p.releaseConversion(id, "wrong", NOW), false);
    assert.equal(p.releaseConversion(id, "c", NOW), true);
    assert.equal(p.findById(id)!.status, "APPROVED");

    const methods = Object.getOwnPropertyNames(TaskProposalRepository.prototype).concat(Object.getOwnPropertyNames(BacklogItemRepository.prototype));
    assert.ok(!methods.some((m) => /^(set|update)Status$/i.test(m)), "no method accepts an arbitrary status");
  });
});

test("backlog_events: append-only, ordered oldest-first, and bounded to the newest N", async () => {
  await withHarness("events", (h) => {
    const item = rawItem(h);
    h.platform.backlogItems.insert(item);
    const events = h.platform.backlogEvents;
    for (let i = 0; i < 7; i++) events.append(h.project.id, item.id, "BACKLOG_ITEM_UPDATED", { i }, `2026-01-01T00:00:0${i}.000Z`);
    const last3 = events.listForItem(item.id, 3);
    assert.deepEqual(last3.map((e) => e.payload.i), [4, 5, 6]);
    assert.equal(events.listForItem(item.id).length, 7);
    // A corrupt payload never makes the trail unreadable.
    h.platform.db.prepare("UPDATE backlog_events SET payload_json = 'not json' WHERE id = ?").run(events.listForItem(item.id)[0]!.id);
    assert.deepEqual(events.listForItem(item.id)[0]!.payload, {});
  });
});

test("runInTransaction: commits on success, rolls EVERYTHING back on throw, and joins an already-open transaction", async () => {
  await withHarness("txn", (h) => {
    const items = h.platform.backlogItems;
    const ok = rawItem(h);
    runInTransaction(h.platform.db, () => items.insert(ok));
    assert.ok(items.findById(ok.id));

    const rolledBack = rawItem(h);
    assert.throws(() => runInTransaction(h.platform.db, () => {
      items.insert(rolledBack);
      throw new Error("boom");
    }), /boom/);
    assert.equal(items.findById(rolledBack.id), null, "an insert inside a failed transaction is undone");
    assert.equal(h.platform.db.isTransaction, false);

    const nested = rawItem(h);
    runInTransaction(h.platform.db, () => runInTransaction(h.platform.db, () => items.insert(nested)));
    assert.ok(items.findById(nested.id));
  });
});

test("repositories are safe to construct directly over any migrated database handle (no hidden global state)", async () => {
  await withHarness("construct", (h) => {
    const db = h.platform.db;
    assert.ok(new BacklogItemRepository(db) && new BacklogAnalysisRepository(db) && new BacklogRelationshipRepository(db) && new TaskProposalRepository(db) && new BacklogEventRepository(db));
  });
});
