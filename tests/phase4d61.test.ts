import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPreview, parseCsv } from "../src/backlog/import-csv.js";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";

describe("Phase 4D.6.1 — CSV Import Header Normalization & Real Dataset Fix", () => {
  describe("1. Real Dataset Header Mapping & Title Parsing", () => {
    test("Jinvani CSV dataset headers map accurately and populated titles are never empty", () => {
      const csv = `\uFEFFBug Id,Module,Bug title,Step to Reproduce ,Expected Result ,Actual Ressult,Priority,Development Status
BUG-ID 001,SignUp,Wrong message appears,1. Open app,It works,It does not,High,open
BUG-ID 002,Player,Toast Message appear continuously,1. Play video,Toast once,Appears continuously,High,open
BUG-ID 006,Profile,Name accept Blank Space,1. Edit profile,Reject spaces,Accepts blank space,Medium,Add-on – not built
BUG-ID 017,Player,Quality selection not avaliable,1. Open player menu,Quality menu,Missing menu,High,Partially done
BUG-ID 078,Settings,,1. Open settings,Settings load,Crash,High,open`;

      const preview = buildPreview(csv);

      assert.equal(preview.errors.length, 0);
      assert.equal(preview.totalRows, 5);
      assert.equal(preview.accepted, 4);
      assert.equal(preview.rejected, 1);

      // Verify row 2 (BUG-ID 002) exact field mapping
      const row2 = preview.rows.find((r) => r.sourceKey === "BUG-ID-002");
      assert.ok(row2);
      assert.equal(row2.status, "ACCEPTED");
      assert.equal(row2.title, "Toast Message appear continuously");
      assert.equal(row2.bugId, "BUG-ID-002");
      assert.equal(row2.fields.module, "Player");
      assert.equal(row2.fields.priority, "High");
      assert.equal(row2.fields.status, "open");
      assert.equal(row2.fields.steps, "1. Play video");
      assert.equal(row2.fields.expected, "Toast once");
      assert.equal(row2.fields.actual, "Appears continuously");

      // Verify row 3 (BUG-ID 006) exact field mapping
      const row6 = preview.rows.find((r) => r.sourceKey === "BUG-ID-006");
      assert.ok(row6);
      assert.equal(row6.status, "ACCEPTED");
      assert.equal(row6.title, "Name accept Blank Space");
      assert.equal(row6.fields.status, "Add-on – not built");

      // Verify row 4 (BUG-ID 017) exact field mapping
      const row17 = preview.rows.find((r) => r.sourceKey === "BUG-ID-017");
      assert.ok(row17);
      assert.equal(row17.status, "ACCEPTED");
      assert.equal(row17.title, "Quality selection not avaliable");

      // Verify row 5 (BUG-ID 078) is rejected specifically for missing title, NOT because header detection failed
      const row78 = preview.rows[4]!;
      assert.equal(row78.status, "REJECTED");
      assert.equal(row78.reason, "missing_title");
      assert.equal(row78.detail, "The title is empty.");
    });

    test("Title mapping precedence prevents 'Issue' or 'Name' column from hijacking 'Bug title'", () => {
      const csv = `Bug Id,Module,Issue,Bug title,Step to Reproduce,Expected Result,Actual Result
BUG-101,Auth,IS-101,Fix login screen button alignment,1. Open login,Button centered,Button off-center`;

      const preview = buildPreview(csv);
      assert.equal(preview.accepted, 1);
      const row = preview.rows[0]!;
      assert.equal(row.title, "Fix login screen button alignment");
    });
  });

  describe("2. Robust CSV Parsing (BOM, CRLF, Quotes, Punctuation)", () => {
    test("Handles UTF-8 BOM, CRLF, embedded quotes, parentheses, and Unicode dashes", () => {
      const csv = "\uFEFF\"Issue Key\",\"Module\",\"Summary\",\"Step to Reproduce\",\"Expected Result\",\"Actual Result\",\"Development Status\"\r\n" +
        "\"BUG-301\",\"Player (iOS)\",\"Zoom issue with 'pinch' & double-tap\",\"1. Open video (HD)\n2. Pinch zoom\",\"Smooth zoom\",\"Jitter / 'glitch'\",\"Add-on – not built\"\r\n";

      const preview = buildPreview(csv);
      assert.equal(preview.errors.length, 0);
      assert.equal(preview.accepted, 1);

      const row = preview.rows[0]!;
      assert.equal(row.bugId, "BUG-301");
      assert.equal(row.title, "Zoom issue with 'pinch' & double-tap");
      assert.equal(row.fields.module, "Player (iOS)");
      assert.equal(row.fields.status, "Add-on – not built");
      assert.match(row.description!, /Smooth zoom/);
      assert.match(row.description!, /Jitter \/ 'glitch'/);
    });
  });

  describe("3. Validation Strictness (Title is Mandatory)", () => {
    test("Row with empty title is STILL rejected with 'The title is empty.' (title is NOT optional)", () => {
      const csv = "Bug Id,Bug title,Description\nBUG-401,,Some valid reproduction description\n";
      const preview = buildPreview(csv);
      assert.equal(preview.accepted, 0);
      assert.equal(preview.rejected, 1);
      assert.equal(preview.rows[0]!.reason, "missing_title");
      assert.equal(preview.rows[0]!.detail, "The title is empty.");
    });
  });

  describe("4. End-to-End Chat Context & Filter-to-Create Integration", () => {
    test("Importing valid CSV sets activeImportId, allows dev-status filtering, preview, and confirmed BACKLOG task creation", async () => {
      const h = await setupBacklogHarness("p4d61-e2e");
      try {
        const csvContent = `Bug Id,Module,Bug title,Step to Reproduce ,Expected Result ,Actual Ressult,Priority,Development Status
BUG-ID 001,SignUp,Toast Message appear continuously,1. Open app,Once,Continuous,High,open
BUG-ID 002,Player,Quality selection not avaliable,1. Open player,Menu,Missing,High,Add-on – not built
BUG-ID 003,Profile,Name accept Blank Space,1. Edit profile,Reject,Accepts,Medium,Add-on – not built
BUG-ID 004,Settings,Fix dark mode toggle,1. Toggle,Theme change,No change,Low,DONE – Merged`;

        // 1. Upload CSV via Chat attachment
        const uploadRes = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
          text: "Importing Jinvani tracker",
          attachment: {
            filename: "Jinvani OTT Feedback Tracker(Application P1).csv",
            mimeType: "text/csv",
            contentBase64: Buffer.from(csvContent).toString("base64"),
          },
        });
        assert.match(uploadRes.assistantMessage.content, /I imported 4 of 4 rows/i);

        // 2. Query count of dev-status Add-on – not built
        const countRes = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
          text: "How many bugs have dev-status Add-on – not built?",
        });
        assert.match(countRes.assistantMessage.content, /2 bugs/i);

        // 3. List matching items
        const listRes = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
          text: "List them.",
        });
        assert.match(listRes.assistantMessage.content, /Quality selection not avaliable/);
        assert.match(listRes.assistantMessage.content, /Name accept Blank Space/);

        // 4. Request task creation preview
        const createRes = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
          text: "Create tasks only for Add-on – not built bugs.",
        });
        assert.ok(createRes.pendingAction);
        assert.equal(createRes.pendingAction.kind, "UPLOAD_TASK_CREATION");
        assert.match(createRes.assistantMessage.content, /2 matching bugs/i);
        assert.match(createRes.assistantMessage.content, /BACKLOG/i);

        // 5. Confirm task creation
        const confirmRes = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
          text: "Yes",
        });
        assert.match(confirmRes.assistantMessage.content, /Created 2 of 2 tasks in BACKLOG/i);

        // 6. Verify created tasks are in BACKLOG and none auto-started
        const tasks = h.platform.tasks.listByProject(h.project.id);
        assert.equal(tasks.length, 2);
        for (const t of tasks) {
          assert.equal(t.status, "BACKLOG");
        }
      } finally {
        h.close();
      }
    });
  });
});
