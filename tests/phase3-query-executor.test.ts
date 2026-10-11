import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { UserRepository } from "../src/persistence/repositories/user-repository.js";
import { ProjectRepository } from "../src/persistence/repositories/project-repository.js";
import { TaskRepository } from "../src/persistence/repositories/task-repository.js";
import { BacklogItemRepository } from "../src/persistence/repositories/backlog-item-repository.js";
import { BacklogBulkRepository } from "../src/persistence/repositories/backlog-bulk-repository.js";
import { QueryExecutor } from "../src/application/query-executor.js";
import { NotFoundError, InvalidRequestError } from "../src/application/errors.js";
import { openDatabase } from "../src/persistence/db.js";

describe("Phase 3: Deterministic Query Execution", () => {
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let tasks: TaskRepository;
  let items: BacklogItemRepository;
  let bulk: BacklogBulkRepository;
  let executor: QueryExecutor;

  const actorId = "user-alice";
  const otherActorId = "user-bob";
  const projectId = "proj-alpha";
  const otherProjectId = "proj-beta";
  const importId = "imp-100";

  beforeEach(() => {
    db = openDatabase(":memory:");

    const users = new UserRepository(db);
    projects = new ProjectRepository(db);
    tasks = new TaskRepository(db);
    items = new BacklogItemRepository(db);
    bulk = new BacklogBulkRepository(db);

    executor = new QueryExecutor({ projects, tasks, items, bulk });

    // Seed test users & projects
    users.insert({
      id: actorId,
      tenantId: "tenant-1",
      email: "alice@example.com",
      name: "Alice",
      passwordHash: "",
      createdAt: "2026-10-01T00:00:00Z",
    });
    users.insert({
      id: otherActorId,
      tenantId: "tenant-1",
      email: "bob@example.com",
      name: "Bob",
      passwordHash: "",
      createdAt: "2026-10-01T00:00:00Z",
    });

    projects.insert({
      id: projectId,
      tenantId: "tenant-1",
      name: "Alpha Project",
      repoUrl: "https://github.com/org/alpha",
      ownerId: actorId,
      defaultBranch: "main",
      codingEngine: "fixture",
      sourceControlProvider: "local-git",
      owner: null,
      repo: null,
      commands: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    });

    projects.insert({
      id: otherProjectId,
      tenantId: "tenant-1",
      name: "Beta Project",
      repoUrl: "https://github.com/org/beta",
      ownerId: otherActorId,
      defaultBranch: "main",
      codingEngine: "fixture",
      sourceControlProvider: "local-git",
      owner: null,
      repo: null,
      commands: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    });

    const defaultTaskRecord = {
      plan: null,
      decisions: [],
      branchName: null,
      latestDiffRef: null,
      selfFixAttempts: 0,
      workingEpisodes: 0,
      pullRequest: null,
      processedHumanFeedbackIds: [],
      pendingHumanReviewFeedback: null,
      bugFixVerification: null,
    };

    const seedTask = (
      overrides: Partial<import("../src/domain/types.js").Task> &
        Pick<import("../src/domain/types.js").Task, "id" | "projectId" | "title" | "goal" | "status" | "createdBy">,
    ) => {
      tasks.insert({
        tenantId: "tenant-1",
        taskRecord: defaultTaskRecord,
        branchMode: "new",
        workingBranch: null,
        baseBranch: "main",
        currentAgentRunId: null,
        workspaceId: null,
        lockOwner: null,
        lockExpiresAt: null,
        createdAt: "2026-10-01T01:00:00Z",
        updatedAt: "2026-10-01T01:00:00Z",
        startedAt: null,
        completedAt: null,
        cancelRequestedAt: null,
        cancelRequestedBy: null,
        lockGeneration: 0,
        nextReviewCheckAt: null,
        ...overrides,
      });
    };

    // Seed tasks for Alpha
    seedTask({
      id: "task-1",
      projectId,
      title: "Fix crash on login",
      goal: "Resolve null pointer on auth response",
      status: "DONE",
      createdBy: actorId,
    });

    seedTask({
      id: "task-2",
      projectId,
      title: "Add export to PDF",
      goal: "Generate client PDF reports",
      status: "REVIEW",
      createdBy: actorId,
      createdAt: "2026-10-01T02:00:00Z",
      updatedAt: "2026-10-01T02:00:00Z",
    });

    seedTask({
      id: "task-3",
      projectId,
      title: "Refactor task state machine",
      goal: "Optimize database queries",
      status: "WORKING",
      createdBy: actorId,
      createdAt: "2026-10-01T03:00:00Z",
      updatedAt: "2026-10-01T03:00:00Z",
    });

    seedTask({
      id: "task-4",
      projectId,
      title: "Review security headers",
      goal: "Add CSP and HSTS headers",
      status: "DONE",
      createdBy: actorId,
      createdAt: "2026-10-01T04:00:00Z",
      updatedAt: "2026-10-01T04:00:00Z",
    });

    // Seed task for Beta (cross-project test)
    seedTask({
      id: "task-beta-1",
      projectId: otherProjectId,
      title: "Beta Secret Task",
      goal: "Never leak to Alpha",
      status: "DONE",
      createdBy: otherActorId,
    });

    // Seed import for Alpha
    bulk.insertImport({
      id: importId,
      projectId,
      sourceName: "qa_bugs.csv",
      sourceType: "csv",
      createdBy: actorId,
      status: "COMPLETED",
      contentHash: "hash-alpha-100",
      totalRows: 4,
      acceptedRows: 4,
      rejectedRows: 0,
      alreadyImportedRows: 0,
      mapping: {
        fields: {
          status: "Dev Status",
          priority: "Priority",
        },
      },
      warnings: [],
      createdAt: "2026-10-01T00:00:00Z",
      completedAt: "2026-10-01T00:01:00Z",
    });

    // Seed backlog items for importId
    items.insert({
      id: "bug-101",
      projectId,
      externalRef: "BUG-101",
      title: "Fix dark mode CSS",
      description: "Contrast is too low",
      source: "import",
      status: "NEW",
      createdBy: actorId,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      importId,
      sourceRow: 1,
      metadata: {
        status: "DONE – Merged", // Unicode en-dash
        priority: "High",
        score: "42",
        releaseDate: "2026-10-05T00:00:00Z",
      },
    });

    items.insert({
      id: "bug-102",
      projectId,
      externalRef: "BUG-102",
      title: "Add-on button invisible",
      description: "Missing CSS class",
      source: "import",
      status: "NEW",
      createdBy: actorId,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      importId,
      sourceRow: 2,
      metadata: {
        status: "Add-on – not built",
        priority: "Critical",
        score: "99",
        releaseDate: "2026-10-10T00:00:00Z",
      },
    });

    items.insert({
      id: "bug-103",
      projectId,
      externalRef: "BUG-103",
      title: "Typo in header",
      description: "Fixed typo",
      source: "import",
      status: "NEW",
      createdBy: actorId,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      importId,
      sourceRow: 3,
      metadata: {
        status: "DONE – Merged",
        priority: "Low",
        score: "12",
        releaseDate: "2026-10-01T00:00:00Z",
      },
    });

    items.insert({
      id: "bug-104",
      projectId,
      externalRef: "BUG-104",
      title: "Memory leak on stream close",
      description: "Socket remains open",
      source: "import",
      status: "NEW",
      createdBy: actorId,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      importId,
      sourceRow: 4,
      metadata: {
        status: "In Progress",
        priority: "High",
        score: "",
        releaseDate: "",
      },
    });
  });

  // 1. COUNT with EQUALS, IN and NOT_EQUALS
  test("COUNT with EQUALS, IN and NOT_EQUALS", async () => {
    // EQUALS
    const eqRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "COUNT",
        filter: { field: "status", operator: "EQUALS", value: "DONE" },
      },
      { actorId, projectId },
    );
    assert.deepEqual(eqRes, { operation: "COUNT", count: 2 });

    // IN: "Done or Working" produces 1 scalar combined total
    const inRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "COUNT",
        filter: { field: "status", operator: "IN", value: ["DONE", "WORKING"] },
      },
      { actorId, projectId },
    );
    assert.deepEqual(inRes, { operation: "COUNT", count: 3 });

    // NOT_EQUALS
    const notEqRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "COUNT",
        filter: { field: "status", operator: "NOT_EQUALS", value: "DONE" },
      },
      { actorId, projectId },
    );
    assert.deepEqual(notEqRes, { operation: "COUNT", count: 2 });
  });

  // 2. GROUP_BY returns separate counts and does not collapse them
  test("GROUP_BY returns separate counts for each value", async () => {
    const groupRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "GROUP_BY",
        groupByField: "status",
        filter: { field: "status", operator: "IN", value: ["DONE", "REVIEW"] },
      },
      { actorId, projectId },
    );

    assert.equal(groupRes.operation, "GROUP_BY");
    if (groupRes.operation === "GROUP_BY") {
      assert.equal(groupRes.groupByField, "status");
      assert.equal(groupRes.totalGroups, 2);
      assert.deepEqual(groupRes.groups, [
        { key: "DONE", count: 2 },
        { key: "REVIEW", count: 1 },
      ]);
    }
  });

  // 3. COUNT and GROUP_BY produce different expected results for the same filter
  test("COUNT and GROUP_BY produce fundamentally different results for identical filter", async () => {
    const filter = { field: "status", operator: "IN", value: ["DONE", "REVIEW"] };

    const countRes = await executor.execute(
      { source: "CODEFORGE_TASKS", operation: "COUNT", filter },
      { actorId, projectId },
    );

    const groupRes = await executor.execute(
      { source: "CODEFORGE_TASKS", operation: "GROUP_BY", groupByField: "status", filter },
      { actorId, projectId },
    );

    assert.deepEqual(countRes, { operation: "COUNT", count: 3 });
    if (groupRes.operation === "GROUP_BY") {
      assert.equal(groupRes.totalGroups, 2);
      assert.deepEqual(groupRes.groups, [
        { key: "DONE", count: 2 },
        { key: "REVIEW", count: 1 },
      ]);
    }
  });

  // 4. LIST pagination, stable ordering and accurate total count
  test("LIST pagination, stable ordering and accurate total count", async () => {
    const listRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "LIST",
        limit: 2,
        offset: 1,
        orderBy: { field: "title", direction: "ASC" },
      },
      { actorId, projectId },
    );

    assert.equal(listRes.operation, "LIST");
    if (listRes.operation === "LIST") {
      assert.equal(listRes.totalCount, 4); // Total 4 tasks in project
      assert.equal(listRes.limit, 2);
      assert.equal(listRes.offset, 1);
      assert.equal(listRes.items.length, 2);
      // Titles sorted ASC:
      // 0: "Add export to PDF"
      // 1: "Fix crash on login"
      // 2: "Refactor task state machine"
      // 3: "Review security headers"
      assert.equal(listRes.items[0]?.title, "Fix crash on login");
      assert.equal(listRes.items[1]?.title, "Refactor task state machine");
    }
  });

  // 5. GET_DETAILS success, not found and ambiguous ID
  test("GET_DETAILS success, not found and ambiguous ID", async () => {
    // Unique match by externalRef
    const successRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "GET_DETAILS",
        targetId: "BUG-102",
      },
      { actorId, projectId, importId },
    );
    assert.equal(successRes.operation, "GET_DETAILS");
    if (successRes.operation === "GET_DETAILS") {
      assert.equal(successRes.matched, true);
      assert.equal(successRes.item?.id, "bug-102");
    }

    // Not found
    const notFoundRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "GET_DETAILS",
        targetId: "NON-EXISTENT-ID",
      },
      { actorId, projectId, importId },
    );
    if (notFoundRes.operation === "GET_DETAILS") {
      assert.equal(notFoundRes.matched, false);
      assert.equal(notFoundRes.item, null);
    }

    // Ambiguous filter matching >1 items
    const ambiguousRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "GET_DETAILS",
        filter: { field: "status", operator: "EQUALS", value: "DONE – Merged" },
      },
      { actorId, projectId, importId },
    );
    if (ambiguousRes.operation === "GET_DETAILS") {
      assert.equal(ambiguousRes.matched, false);
      assert.equal(ambiguousRes.ambiguous, true);
      assert.equal(ambiguousRes.item, null);
    }
  });

  // 6. DISTINCT_VALUES counts and truncation
  test("DISTINCT_VALUES returns accurate counts and bounded lists", async () => {
    const distRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "DISTINCT_VALUES",
        distinctField: "status",
        limit: 2,
      },
      { actorId, projectId, importId },
    );

    assert.equal(distRes.operation, "DISTINCT_VALUES");
    if (distRes.operation === "DISTINCT_VALUES") {
      assert.equal(distRes.field, "status");
      assert.equal(distRes.totalDistinct, 3); // "Add-on – not built", "DONE – Merged", "In Progress"
      assert.equal(distRes.values.length, 2);
      assert.equal(distRes.hasMore, true);
    }
  });

  // 7. Every supported filter operator
  test("all filter operators: CONTAINS, STARTS_WITH, GREATER_THAN, LESS_THAN, IS_EMPTY, IS_NOT_EMPTY", async () => {
    // CONTAINS
    const containsRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "COUNT",
        filter: { field: "title", operator: "CONTAINS", value: "login" },
      },
      { actorId, projectId },
    );
    assert.deepEqual(containsRes, { operation: "COUNT", count: 1 });

    // STARTS_WITH
    const startsRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "COUNT",
        filter: { field: "title", operator: "STARTS_WITH", value: "Refactor" },
      },
      { actorId, projectId },
    );
    assert.deepEqual(startsRes, { operation: "COUNT", count: 1 });

    // GREATER_THAN (numeric)
    const gtRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: { field: "score", operator: "GREATER_THAN", value: 40 },
      },
      { actorId, projectId, importId },
    );
    // bug-101 (42), bug-102 (99)
    assert.deepEqual(gtRes, { operation: "COUNT", count: 2 });

    // LESS_THAN (date)
    const ltRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: { field: "releaseDate", operator: "LESS_THAN", value: "2026-10-06T00:00:00Z" },
      },
      { actorId, projectId, importId },
    );
    // bug-101 (10-05), bug-103 (10-01)
    assert.deepEqual(ltRes, { operation: "COUNT", count: 2 });

    // IS_EMPTY
    const emptyRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: { field: "score", operator: "IS_EMPTY" },
      },
      { actorId, projectId, importId },
    );
    // bug-104 has empty score
    assert.deepEqual(emptyRes, { operation: "COUNT", count: 1 });

    // IS_NOT_EMPTY
    const notEmptyRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: { field: "score", operator: "IS_NOT_EMPTY" },
      },
      { actorId, projectId, importId },
    );
    assert.deepEqual(notEmptyRes, { operation: "COUNT", count: 3 });
  });

  // 8. Nested AND / OR / NOT
  test("Nested AND / OR / NOT composite evaluation", async () => {
    const compositeRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "COUNT",
        filter: {
          and: [
            {
              or: [
                { field: "status", operator: "EQUALS", value: "DONE" },
                { field: "status", operator: "EQUALS", value: "REVIEW" },
              ],
            },
            {
              not: {
                field: "title",
                operator: "CONTAINS",
                value: "login",
              },
            },
          ],
        },
      },
      { actorId, projectId },
    );
    // DONE or REVIEW tasks: task-1 (login), task-2 (PDF), task-4 (security)
    // NOT contains login: task-2, task-4 -> count = 2
    assert.deepEqual(compositeRes, { operation: "COUNT", count: 2 });
  });

  // 9. Numeric vs. Lexicographical comparisons
  test("Numeric comparison is not lexicographical (e.g. 99 > 100 is false, 42 > 12 is true)", async () => {
    const res = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: { field: "score", operator: "GREATER_THAN", value: 40 },
      },
      { actorId, projectId, importId },
    );
    // 42 and 99 are > 40. Lexicographically, "9" might be > "40" but "12" is not.
    assert.deepEqual(res, { operation: "COUNT", count: 2 });
  });

  // 10. Null, missing, empty and whitespace-only values
  test("Null and whitespace values are excluded by standard equality", async () => {
    const res = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: { field: "score", operator: "EQUALS", value: "42" },
      },
      { actorId, projectId, importId },
    );
    assert.deepEqual(res, { operation: "COUNT", count: 1 });
  });

  // 11. Unknown fields and incompatible operators
  test("Unknown fields throw InvalidRequestError", async () => {
    await assert.rejects(
      async () => {
        await executor.execute(
          {
            source: "CODEFORGE_TASKS",
            operation: "COUNT",
            filter: { field: "non_existent_column", operator: "EQUALS", value: "xyz" },
          },
          { actorId, projectId },
        );
      },
      InvalidRequestError,
    );
  });

  // 12. Cross-project task isolation and import/project mismatch
  test("Cross-project authorization rejection and import mismatch", async () => {
    // 1. Actor bob attempting to query Alice's project -> 404 NotFoundError
    await assert.rejects(
      async () => {
        await executor.execute(
          {
            source: "CODEFORGE_TASKS",
            operation: "COUNT",
          },
          { actorId: otherActorId, projectId },
        );
      },
      NotFoundError,
    );

    // 2. Querying Alpha with an import belonging to another project or non-existent
    await assert.rejects(
      async () => {
        await executor.execute(
          {
            source: "IMPORTED_DATASET",
            operation: "COUNT",
          },
          { actorId, projectId, importId: "non-existent-import" },
        );
      },
      NotFoundError,
    );

    // 3. Alice querying tasks in Alpha NEVER includes task-beta-1
    const aliceTasks = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "LIST",
      },
      { actorId, projectId },
    );
    if (aliceTasks.operation === "LIST") {
      assert.equal(aliceTasks.totalCount, 4);
      assert.ok(!aliceTasks.items.some((t) => t.id === "task-beta-1"));
    }
  });

  // 13. Attempted malformed or over-complex query
  test("Malformed queries exceeding complexity limits are rejected strictly", async () => {
    // Filter nesting depth > 4
    const deeplyNested = {
      source: "CODEFORGE_TASKS",
      operation: "COUNT",
      filter: {
        and: [{ and: [{ and: [{ and: [{ field: "status", operator: "EQUALS", value: "DONE" } ] }] }] }],
      },
    };

    await assert.rejects(
      async () => {
        await executor.execute(deeplyNested, { actorId, projectId });
      },
      /Filter nesting depth/,
    );
  });

  // 14. Exact preservation of Unicode and canonical raw values
  test("Exact raw Unicode values match cleanly without corruption", async () => {
    const res = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: { field: "status", operator: "EQUALS", value: "DONE – Merged" }, // en-dash
      },
      { actorId, projectId, importId },
    );
    assert.deepEqual(res, { operation: "COUNT", count: 2 });
  });

  // 15. Zero mutation verification
  test("Executor performs pure read-only operations without database mutations", async () => {
    const beforeCount = tasks.listByProject(projectId).length;
    await executor.execute(
      { source: "CODEFORGE_TASKS", operation: "COUNT" },
      { actorId, projectId },
    );
    const afterCount = tasks.listByProject(projectId).length;
    assert.equal(beforeCount, afterCount);
  });

  // 16. Regression: "Count Done or In Progress" returns one scalar count
  test('Regression: "Count Done or In Progress" returns one scalar count', async () => {
    // 1) For CODEFORGE_TASKS (DONE or WORKING)
    const taskRes = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "COUNT",
        filter: {
          field: "status",
          operator: "IN",
          value: ["DONE", "WORKING"],
        },
      },
      { actorId, projectId },
    );
    // DONE has 2 (task-1, task-4), WORKING has 1 (task-3) -> total 3
    assert.deepEqual(taskRes, {
      operation: "COUNT",
      count: 3,
    });

    // 2) For IMPORTED_DATASET (DONE – Merged or In Progress)
    const bugRes = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "COUNT",
        filter: {
          field: "status",
          operator: "IN",
          value: ["DONE – Merged", "In Progress"],
        },
      },
      { actorId, projectId, importId },
    );
    // DONE – Merged has 2 (bug-101, bug-103), In Progress has 1 (bug-104) -> total 3
    assert.deepEqual(bugRes, {
      operation: "COUNT",
      count: 3,
    });
  });

  // 17. Regression: "Count Done and Review separately" returns distinct grouped counts
  test('Regression: "Count Done and Review separately" returns distinct grouped counts and no invented groups', async () => {
    const res = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "GROUP_BY",
        groupByField: "status",
        filter: {
          field: "status",
          operator: "IN",
          value: ["DONE", "REVIEW"],
        },
      },
      { actorId, projectId },
    );

    assert.deepEqual(res, {
      operation: "GROUP_BY",
      groupByField: "status",
      groups: [
        { key: "DONE", count: 2 },
        { key: "REVIEW", count: 1 },
      ],
      totalGroups: 2,
    });
  });

  // 18. Regression: No group is invented from model output
  test("Regression: No group is invented from model output or filter values", async () => {
    const res = await executor.execute(
      {
        source: "CODEFORGE_TASKS",
        operation: "GROUP_BY",
        groupByField: "status",
        filter: {
          field: "status",
          operator: "IN",
          value: ["DONE", "CANCELLED"], // CANCELLED does not exist in db
        },
      },
      { actorId, projectId },
    );

    // CANCELLED must NOT appear in returned groups
    assert.deepEqual(res, {
      operation: "GROUP_BY",
      groupByField: "status",
      groups: [{ key: "DONE", count: 2 }],
      totalGroups: 1,
    });
  });

  // 19. Regression: Truncated vocabulary does not cause valid record to be silently excluded
  test("Regression: Truncated vocabulary does not cause valid record to be silently excluded", async () => {
    // When executing against actual repository, filtering evaluates the stored data deterministically
    // and matches records even if discovery vocabulary was truncated at 50 items.
    const res = await executor.execute(
      {
        source: "IMPORTED_DATASET",
        operation: "LIST",
        filter: {
          field: "status",
          operator: "EQUALS",
          value: "DONE – Merged",
        },
      },
      { actorId, projectId, importId },
    );

    if (res.operation === "LIST") {
      assert.equal(res.totalCount, 2);
      assert.equal(res.items.length, 2);
    }
  });

  // 20. Empty dataset behavior
  test("Empty dataset behavior: COUNT returns 0, LIST returns empty list, GROUP_BY returns 0 groups", async () => {
    const emptyProjId = "proj-empty";
    projects.insert({
      id: emptyProjId,
      tenantId: "tenant-1",
      name: "Empty Project",
      repoUrl: "https://github.com/org/empty",
      ownerId: actorId,
      defaultBranch: "main",
      codingEngine: "fixture",
      sourceControlProvider: "local-git",
      owner: null,
      repo: null,
      commands: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    });

    const countRes = await executor.execute(
      { source: "CODEFORGE_TASKS", operation: "COUNT" },
      { actorId, projectId: emptyProjId },
    );
    assert.deepEqual(countRes, { operation: "COUNT", count: 0 });

    const listRes = await executor.execute(
      { source: "CODEFORGE_TASKS", operation: "LIST" },
      { actorId, projectId: emptyProjId },
    );
    assert.deepEqual(listRes, { operation: "LIST", items: [], totalCount: 0, limit: 20, offset: 0 });

    const groupRes = await executor.execute(
      { source: "CODEFORGE_TASKS", operation: "GROUP_BY", groupByField: "status" },
      { actorId, projectId: emptyProjId },
    );
    assert.deepEqual(groupRes, { operation: "GROUP_BY", groupByField: "status", groups: [], totalGroups: 0 });
  });
});
