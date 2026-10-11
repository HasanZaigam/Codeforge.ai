import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupBacklogHarness } from "./helpers/backlog-harness.js";
import { InvalidRequestError, NotFoundError } from "../src/application/errors.js";

/**
 * Phase 4D.2 — Chat image/screenshot attachments. The stack has NO multimodal call path
 * (BacklogAnalyzer.run takes a flat text prompt), so these tests verify: (a) real files in the three
 * supported formats are accepted, validated by actual magic bytes (never the claimed extension/MIME
 * alone), and stored as bounded metadata only; (b) Chat never fakes an analysis of the image content;
 * (c) the same authorization/size/filename-safety rules as every other attachment type apply unchanged.
 */

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
function webpBytes(): Buffer {
  const riff = Buffer.from("RIFF", "ascii");
  const size = Buffer.from([0, 0, 0, 0]);
  const webp = Buffer.from("WEBP", "ascii");
  return Buffer.concat([riff, size, webp, Buffer.from([0, 0, 0, 0])]);
}

describe("Chat image attachments (Phase 4D.2)", () => {
  test("1. PNG upload is accepted and Chat truthfully says it cannot analyse it", async () => {
    const h = await setupBacklogHarness("img-png");
    try {
      const { userMessage, assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "What's wrong in this screenshot?",
        attachment: { filename: "screenshot.png", mimeType: "image/png", contentBase64: PNG_BYTES.toString("base64") },
      });
      assert.equal(h.engine.calls.length, 0, "no model call was ever made — a fabricated analysis would require one");
      assert.match(assistantMessage.content, /doesn't support image analysis|can't read or describe/i);
      assert.equal(userMessage.attachment!.filename, "screenshot.png");
    } finally {
      h.close();
    }
  });

  test("2. JPEG upload is accepted", async () => {
    const h = await setupBacklogHarness("img-jpeg");
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "",
        attachment: { filename: "photo.jpg", mimeType: "image/jpeg", contentBase64: JPEG_BYTES.toString("base64") },
      });
      assert.match(assistantMessage.content, /doesn't support image analysis|can't read or describe/i);
    } finally {
      h.close();
    }
  });

  test("3. WEBP upload is accepted", async () => {
    const h = await setupBacklogHarness("img-webp");
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "",
        attachment: { filename: "shot.webp", mimeType: "image/webp", contentBase64: webpBytes().toString("base64") },
      });
      assert.match(assistantMessage.content, /doesn't support image analysis|can't read or describe/i);
    } finally {
      h.close();
    }
  });

  test("4. unsupported image-like extension is rejected", async () => {
    const h = await setupBacklogHarness("img-unsupported");
    try {
      await assert.rejects(
        () => h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "", attachment: { filename: "icon.gif", mimeType: "image/gif", contentBase64: PNG_BYTES.toString("base64") } }),
        InvalidRequestError,
      );
    } finally {
      h.close();
    }
  });

  test("5. oversized image is rejected before any processing", async () => {
    const h = await setupBacklogHarness("img-oversized");
    try {
      const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(7 * 1024 * 1024)]);
      await assert.rejects(
        () => h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "", attachment: { filename: "huge.png", mimeType: "image/png", contentBase64: huge.toString("base64") } }),
        InvalidRequestError,
      );
    } finally {
      h.close();
    }
  });

  test("6. content that doesn't match its claimed image extension (real magic-byte check) is rejected", async () => {
    const h = await setupBacklogHarness("img-magic-byte-mismatch");
    try {
      const notReallyAnImage = Buffer.from("just some plain text content, not image bytes at all", "utf8");
      await assert.rejects(
        () => h.services.chat.sendMessage(h.project.id, h.owner.id, { text: "", attachment: { filename: "fake.png", mimeType: "image/png", contentBase64: notReallyAnImage.toString("base64") } }),
        InvalidRequestError,
      );
    } finally {
      h.close();
    }
  });

  test("7. authorization: a stranger cannot attach an image to this project's conversation", async () => {
    const h = await setupBacklogHarness("img-authz");
    try {
      const stranger = h.addUser("stranger");
      await assert.rejects(
        () =>
          h.services.chat.sendMessage(h.project.id, stranger.id, { text: "", attachment: { filename: "x.png", mimeType: "image/png", contentBase64: PNG_BYTES.toString("base64") } }),
        NotFoundError,
      );
    } finally {
      h.close();
    }
  });

  test("8. filename/path safety: a path-traversal-style filename is sanitized to its basename", async () => {
    const h = await setupBacklogHarness("img-path-safety");
    try {
      const { userMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "",
        attachment: { filename: "../../etc/evil.png", mimeType: "image/png", contentBase64: PNG_BYTES.toString("base64") },
      });
      assert.equal(userMessage.attachment!.filename, "evil.png");
    } finally {
      h.close();
    }
  });

  test("9. persistence: only bounded metadata (filename/mimeType/byteSize) is stored, never raw image bytes", async () => {
    const h = await setupBacklogHarness("img-persistence");
    try {
      const { userMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "",
        attachment: { filename: "screenshot.png", mimeType: "image/png", contentBase64: PNG_BYTES.toString("base64") },
      });
      assert.deepEqual(Object.keys(userMessage.attachment!).sort(), ["byteSize", "filename", "mimeType"]);
      assert.equal(userMessage.attachment!.byteSize, PNG_BYTES.byteLength);
      assert.equal(JSON.stringify(userMessage).includes(PNG_BYTES.toString("base64")), false, "raw bytes must never be persisted");
    } finally {
      h.close();
    }
  });

  test("10. the attachment is associated with the USER message, never the assistant's reply", async () => {
    const h = await setupBacklogHarness("img-association");
    try {
      const { userMessage, assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "",
        attachment: { filename: "screenshot.png", mimeType: "image/png", contentBase64: PNG_BYTES.toString("base64") },
      });
      assert.ok(userMessage.attachment);
      assert.equal(assistantMessage.attachment, null);

      const messages = h.services.chat.listMessages(h.project.id, h.owner.id);
      const persistedUser = messages.find((m) => m.id === userMessage.id)!;
      assert.equal(persistedUser.attachment!.filename, "screenshot.png");
    } finally {
      h.close();
    }
  });

  test("11. an image attachment never routes through the bulk import/analysis pipeline (that's for CSV/XLSX only)", async () => {
    const h = await setupBacklogHarness("img-not-bulk");
    try {
      const before = h.platform.tasks.listByProject(h.project.id).length;
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "",
        attachment: { filename: "screenshot.png", mimeType: "image/png", contentBase64: PNG_BYTES.toString("base64") },
      });
      assert.equal(assistantMessage.bulkJobId, null);
      assert.equal(h.platform.tasks.listByProject(h.project.id).length, before);
    } finally {
      h.close();
    }
  });

  test("12. no public exposure: the response never includes a URL, path, or link to the uploaded file", async () => {
    const h = await setupBacklogHarness("img-no-exposure");
    try {
      const { assistantMessage } = await h.services.chat.sendMessage(h.project.id, h.owner.id, {
        text: "",
        attachment: { filename: "screenshot.png", mimeType: "image/png", contentBase64: PNG_BYTES.toString("base64") },
      });
      assert.doesNotMatch(assistantMessage.content, /https?:\/\/|\/uploads\/|\/files\//);
    } finally {
      h.close();
    }
  });
});
