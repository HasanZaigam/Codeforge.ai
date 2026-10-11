import { Router, raw } from "express";
import { randomUUID } from "node:crypto";

/**
 * Phase 4D.7 — binary file upload for chat attachments (Goal E).
 *
 * Solves the `413 Payload Too Large` problem: screenshots/images are uploaded here as raw binary
 * (application/octet-stream), NOT base64-inside-JSON. The client PUTs the raw bytes + filename/mime
 * in headers, receives an `attachmentId`, then references that ID in the subsequent
 * `POST /projects/:projectId/chat/messages` — ChatService retrieves the pending attachment by ID.
 *
 * Storage is deliberately in-memory with a short TTL (5 minutes). Attachments are ephemeral transit
 * data — the durable result of an upload is the backlog import / analysis rows it produces, never
 * the raw bytes themselves (see migration 022's own doc comment). A server restart clears pending
 * uploads; the client simply re-uploads and retries.
 */

/** In-memory pending attachment store — keyed by attachmentId. */
export interface PendingAttachment {
  id: string;
  filename: string;
  mimeType: string;
  /** Raw binary bytes — held only until the attachment is consumed by sendMessage or expires. */
  buffer: Buffer;
  createdAt: number;
}

const pendingAttachments = new Map<string, PendingAttachment>();

/** 5-minute TTL for pending attachments — if the client doesn't reference it in a message by then, it's dropped. */
const ATTACHMENT_TTL_MS = 5 * 60 * 1000;

/** Max 10 MB raw upload (generous for screenshots; ChatService enforces the real per-type cap). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Periodic cleanup of expired pending attachments — runs at most once per minute. */
let lastCleanup = Date.now();
function cleanupExpired(): void {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [id, att] of pendingAttachments) {
    if (now - att.createdAt > ATTACHMENT_TTL_MS) {
      pendingAttachments.delete(id);
    }
  }
}

/**
 * Retrieve and remove a pending attachment by ID (one-time consumption).
 * Returns null if the ID doesn't exist or has expired.
 */
export function consumePendingAttachment(attachmentId: string): PendingAttachment | null {
  cleanupExpired();
  const att = pendingAttachments.get(attachmentId);
  if (!att) return null;
  if (Date.now() - att.createdAt > ATTACHMENT_TTL_MS) {
    pendingAttachments.delete(attachmentId);
    return null;
  }
  pendingAttachments.delete(attachmentId);
  return att;
}

export function chatAttachmentsRouter(): Router {
  const router = Router();

  router.post(
    "/projects/:projectId/chat/attachments",
    raw({ type: "application/octet-stream", limit: MAX_UPLOAD_BYTES }),
    (req, res) => {
      cleanupExpired();

      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.byteLength === 0) {
        res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Expected a non-empty binary body with Content-Type: application/octet-stream." } });
        return;
      }

      // File metadata comes from headers — the client sets these before uploading.
      const filename = (req.headers["x-attachment-filename"] as string || "").trim().slice(0, 200);
      const mimeType = (req.headers["x-attachment-mime-type"] as string || "application/octet-stream").trim().slice(0, 100);

      if (!filename) {
        res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Missing x-attachment-filename header." } });
        return;
      }

      const id = randomUUID();
      pendingAttachments.set(id, {
        id,
        filename,
        mimeType,
        buffer: buf,
        createdAt: Date.now(),
      });

      console.log(`[chat-attachment-upload] id=${id} filename=${filename} mimeType=${mimeType} bytes=${buf.byteLength}`);
      res.status(201).json({ attachmentId: id, filename, byteSize: buf.byteLength });
    },
  );

  return router;
}
