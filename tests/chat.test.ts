import { test, describe } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { setupBacklogHarness, json, validAnalysis } from "./helpers/backlog-harness.js";
import { InvalidRequestError, NotFoundError } from "../src/application/errors.js";

/**
 * Phase 4C — Chat. Reuses the SAME backlog test harness (real ScriptedEngine "model", real
 * BacklogBulkService/BacklogAnalyzer call paths) as every other backlog suite — Chat is a new entry
 * point into that existing machinery, never a second implementation of it.
 */

const CSV_HEADER = "Bug Id,Bug title,Step to Reproduce,Expected Result,Actual Result\n";
const csvRow = (id: string, title: string) => `${id},${title},Open the app,Works,Broken\n`;

async function xlsxBase64(rows: string[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Bugs");
  for (const row of rows) sheet.addRow(row);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString("base64");
}

describe("Chat (Phase 4C)", () => {
  test("a plain text message is answered via the SAME BacklogAnalyzer/engine call path as backlog analysis, and persists", async () => {
    const h = await setupBacklogHarness("chat-text", { respond: () => "OTP codes expire after 5 minutes in this project." });
    try {
      const { userMessage, assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "Explain how OTP works here." });
      assert.equal(userMessage.role, "user");
      assert.equal(userMessage.content, "Explain how OTP works here.");
      assert.equal(assistantMessage.role, "assistant");
      assert.equal(assistantMessage.content, "OTP codes expire after 5 minutes in this project.");
      assert.equal(h.engine.calls.length, 1);
      assert.equal(h.engine.calls[0]!.promptOverride?.includes("Jinvani"), true, "the prompt is grounded in the actual project, not a generic chatbot");

      const messages = h.services.chat.listMessages(h.project.id, h.owner.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]!.id, userMessage.id);
      assert.equal(messages[1]!.id, assistantMessage.id);
    } finally {
      h.close();
    }
  });

  test("an engine failure is reported as a graceful assistant message, never a thrown error", async () => {
    const h = await setupBacklogHarness("chat-fail", { respond: () => { throw new Error("boom"); } });
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "hello" });
      assert.equal(assistantMessage.role, "assistant");
      assert.match(assistantMessage.content, /couldn't process/i);
    } finally {
      h.close();
    }
  });

  test("a CSV attachment reuses the EXISTING import + bulk-analysis pipeline unchanged, and suggestions reflect the real analysis outcome", async () => {
    const h = await setupBacklogHarness("chat-csv", { respond: () => json(validAnalysis()) });
    try {
      const csv = CSV_HEADER + csvRow("BUG-1", "OTP not rate limited") + csvRow("BUG-2", "Profile picture upload fails");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "Analyse these bugs.",
        attachment: { filename: "bugs.csv", mimeType: "text/csv", contentBase64: Buffer.from(csv, "utf8").toString("base64") },
      });
      assert.match(assistantMessage.content, /imported 2 of 2/i);
      assert.ok(assistantMessage.bulkJobId, "the assistant message records which bulk run it started");

      await h.platform.backlogRunner.drain();

      const suggestions = h.services.chat.listSuggestions(h.project.id, assistantMessage.bulkJobId!, h.owner.id);
      assert.equal(suggestions.length, 2);
      assert.equal(suggestions.every((s) => s.ref?.includes("BUG-1") || s.ref?.includes("BUG-2")), true);

      const { createdTaskIds, results } = await h.services.chat.createTasks(h.project.id, suggestions.map((s) => s.itemId), h.owner.id);
      assert.equal(createdTaskIds.length, 2);
      assert.equal(results.every((r) => r.ok), true);
      for (const taskId of createdTaskIds) {
        const task = h.platform.tasks.findById(taskId);
        assert.ok(task, "the task exists");
        // The critical product invariant: Chat creates a Task via the EXISTING conversion path, it does NOT start one.
        assert.equal(task!.status, "BACKLOG");
      }
    } finally {
      h.close();
    }
  });

  test("an XLSX attachment is converted to the SAME CSV shape and imported through the SAME pipeline as a .csv", async () => {
    const h = await setupBacklogHarness("chat-xlsx", { respond: () => json(validAnalysis()) });
    try {
      const b64 = await xlsxBase64([
        ["Bug Id", "Bug title", "Step to Reproduce", "Expected Result", "Actual Result"],
        ["BUG-9", "Video freezes on seek", "Play a video and seek", "Smooth seek", "Freezes"],
      ]);
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "",
        attachment: { filename: "bugs.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBase64: b64 },
      });
      assert.match(assistantMessage.content, /imported 1 of 1/i);
    } finally {
      h.close();
    }
  });

  test("rejects a file claiming .xlsx that is not really a zip archive (no trusting client-declared type)", async () => {
    const h = await setupBacklogHarness("chat-fake-xlsx", {});
    try {
      const fakeXlsx = Buffer.from("this is not a real spreadsheet", "utf8").toString("base64");
      await assert.rejects(
        () => h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "", attachment: { filename: "bugs.xlsx", mimeType: "application/octet-stream", contentBase64: fakeXlsx } }),
        (err: unknown) => err instanceof InvalidRequestError && /zip signature/i.test(err.message),
      );
    } finally {
      h.close();
    }
  });

  test("rejects an unsupported file extension", async () => {
    const h = await setupBacklogHarness("chat-badext", {});
    try {
      await assert.rejects(
        () => h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "", attachment: { filename: "malware.exe", mimeType: "application/octet-stream", contentBase64: "AAAA" } }),
        InvalidRequestError,
      );
    } finally {
      h.close();
    }
  });

  test("rejects binary content mislabeled as a text attachment", async () => {
    const h = await setupBacklogHarness("chat-binary-txt", {});
    try {
      const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]).toString("base64");
      await assert.rejects(
        () => h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "", attachment: { filename: "notes.txt", mimeType: "text/plain", contentBase64: binary } }),
        InvalidRequestError,
      );
    } finally {
      h.close();
    }
  });

  test("a .txt/.md attachment is folded into the prompt as untrusted reference data, never imported as a bug sheet", async () => {
    const h = await setupBacklogHarness("chat-txt", { respond: (req) => (req.promptOverride?.includes("untrusted reference data") ? "Got it, thanks for the spec." : "no") });
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "Summarize this.",
        attachment: { filename: "spec.md", mimeType: "text/markdown", contentBase64: Buffer.from("# Requirements\nSupport dark mode.", "utf8").toString("base64") },
      });
      assert.equal(assistantMessage.content, "Got it, thanks for the spec.");
      assert.equal(assistantMessage.bulkJobId, null, "a plain document never starts a bulk analysis run");
    } finally {
      h.close();
    }
  });

  test("no confirmation, no persistent Task: suggestions exist but createTasks is never called", async () => {
    const h = await setupBacklogHarness("chat-no-confirm", { respond: () => json(validAnalysis()) });
    try {
      const csv = CSV_HEADER + csvRow("BUG-5", "Login fails on slow network");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        attachment: { filename: "bugs.csv", mimeType: "text/csv", contentBase64: Buffer.from(csv, "utf8").toString("base64") },
        text: "",
      });
      await h.platform.backlogRunner.drain();
      h.services.chat.listSuggestions(h.project.id, assistantMessage.bulkJobId!, h.owner.id);
      const before = h.platform.tasks.listByProject(h.project.id).length;
      assert.equal(before, 0, "no Task exists until the user explicitly asks to create one");
    } finally {
      h.close();
    }
  });

  test("SECURITY: a user with no access to the project cannot read or send chat messages, or list suggestions", async () => {
    const h = await setupBacklogHarness("chat-isolation", { respond: () => json(validAnalysis()) });
    try {
      const stranger = h.addUser("stranger");
      await assert.rejects(() => h.services.chat.sendMessage(h.project.id, stranger.id, { text: "hi" }), NotFoundError);
      assert.throws(() => h.services.chat.listMessages(h.project.id, stranger.id), NotFoundError);

      const csv = CSV_HEADER + csvRow("BUG-1", "x");
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "", attachment: { filename: "b.csv", mimeType: "text/csv", contentBase64: Buffer.from(csv).toString("base64") } });
      assert.throws(() => h.services.chat.listSuggestions(h.project.id, assistantMessage.bulkJobId!, stranger.id), NotFoundError);
    } finally {
      h.close();
    }
  });

  test("rejects an attachment over the size limit", async () => {
    const h = await setupBacklogHarness("chat-oversized", {});
    try {
      const big = "a".repeat(600_000);
      await assert.rejects(
        () => h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "", attachment: { filename: "huge.txt", mimeType: "text/plain", contentBase64: Buffer.from(big).toString("base64") } }),
        (err: unknown) => err instanceof InvalidRequestError && /larger than/.test(err.message),
      );
    } finally {
      h.close();
    }
  });

  test("rejects an empty message with no attachment", async () => {
    const h = await setupBacklogHarness("chat-empty", {});
    try {
      await assert.rejects(() => h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "" }), InvalidRequestError);
    } finally {
      h.close();
    }
  });
});
