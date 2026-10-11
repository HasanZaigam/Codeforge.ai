import { useEffect, useRef, useState, type FormEvent } from "react";
import { useChat } from "../../hooks/useChat.js";
import { chatApi } from "../../api/index.js";
import { formatRelative } from "../../lib/time.js";
import { ErrorState } from "../common/ErrorState.js";
import { TaskSuggestions } from "./TaskSuggestions.js";

/** Phase 4D.2 — screenshots/images are accepted and uploaded, but see the empty-state note below: the
 * currently configured model/provider has no image-analysis path, so ChatService responds truthfully
 * rather than faking an analysis. See /docs/CHAT.md "Image attachments". */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const ACCEPTED_EXTENSIONS = [".csv", ".xlsx", ".txt", ".md", ...IMAGE_EXTENSIONS];
/** Client-side sanity bound only — the real, enforced limit is server-side (ChatService.MAX_ATTACHMENT_BYTES / MAX_IMAGE_BYTES). */
const MAX_CLIENT_FILE_BYTES = 500_000;
/** Screenshots are legitimately larger than a text/CSV attachment but still bounded — matches ChatService.MAX_IMAGE_BYTES. */
const MAX_CLIENT_IMAGE_BYTES = 6 * 1024 * 1024;

function isImageFile(f: File): boolean {
  const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/** Visual-only suggestion chips — each just fills the composer text; nothing is sent until the user hits Send. */
const SUGGESTION_CHIPS = ["Explain this project", "Analyse a bug sheet", "Find related bugs", "Prepare tasks from requirements"];

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<data>" — strip the prefix.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Project-aware Chat, living inside Overview (Phase 4C) — not a separate tab. Text-only messages are
 * answered by the existing analysis engine grounded in this project's context; a CSV/XLSX attachment
 * is routed through the existing backlog import + bulk-analysis pipeline (see ChatService). Task
 * suggestions render inline under the message that started an analysis run (see TaskSuggestions) and
 * are never auto-created — see /docs/CHAT.md.
 */
export function ChatPanel({ projectId }: { projectId: string }) {
  const { messages, pendingAction, loading, error, send, sending, sendError, confirmPendingAction, declinePendingAction } = useChat(projectId);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const [fileError, setFileError] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Standard chat behavior: open (and stay) scrolled to the LATEST message, not the first one — on
  // initial load/refresh, and again whenever a new message/pending-action/typing indicator appears.
  // jsdom (the test environment) has no real layout engine and doesn't implement scrollIntoView, so this
  // is a no-op (not an error) there — guarded rather than assumed present.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages, pendingAction, sending]);

  // Revoke any previously-created object URL whenever the previewed file changes/clears, so we never leak blobs.
  useEffect(() => {
    if (!file || !isImageFile(file)) {
      setPreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function handleFileChange(f: File | undefined) {
    setFileError(undefined);
    if (!f) {
      setFile(undefined);
      return;
    }
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setFileError(`Unsupported file type — attach a ${ACCEPTED_EXTENSIONS.join(", ")} file.`);
      setFile(undefined);
      return;
    }
    const limit = isImageFile(f) ? MAX_CLIENT_IMAGE_BYTES : MAX_CLIENT_FILE_BYTES;
    if (f.size > limit) {
      setFileError(`That file is larger than ${Math.round(limit / 1000)} KB.`);
      setFile(undefined);
      return;
    }
    setFile(f);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const currentText = text.trim();
    const currentFile = file;
    if (!currentText && !currentFile) return;

    // Phase 4D.7 — images use the binary upload endpoint to avoid the 1 MB JSON body limit (413).
    // Non-image files (CSV/XLSX/TXT/MD) continue to use the existing inline base64 path unchanged.
    if (currentFile && isImageFile(currentFile)) {
      // Clear composer state immediately so the user can type while we upload.
      setText("");
      setFile(undefined);
      if (fileInputRef.current) fileInputRef.current.value = "";

      let uploadId: string;
      try {
        const { attachmentId } = await chatApi.uploadAttachment(projectId, currentFile);
        uploadId = attachmentId;
        console.log(`[chat-send] image uploaded via binary endpoint attachmentId=${attachmentId} filename=${currentFile.name}`);
      } catch (err) {
        // Upload failed — surface the error; do NOT send a message with no attachment reference.
        console.error("[chat-send] image upload failed:", err);
        // Restore the text so the user doesn't lose it; the file is already cleared (intentional — same
        // as the existing error path: file inputs can't be restored programmatically for security reasons).
        setText(currentText);
        // Re-throw so useChat.sendError surfaces it — but we're calling chatApi directly here, so
        // we surface it via fileError instead (same slot the client-side validation already uses).
        setFileError(err instanceof Error ? `Upload failed: ${err.message}` : "Upload failed. Please try again.");
        return;
      }

      await send(currentText, undefined, uploadId, { filename: currentFile.name, mimeType: currentFile.type || "application/octet-stream" });
      return;
    }

    // Non-image path (CSV/XLSX/TXT/MD) — existing inline base64 behavior, unchanged.
    let attachment: { filename: string; mimeType: string; contentBase64: string } | undefined = undefined;
    if (currentFile) {
      try {
        const contentBase64 = await readFileAsBase64(currentFile);
        attachment = {
          filename: currentFile.name,
          mimeType: currentFile.type || "application/octet-stream",
          contentBase64,
        };
      } catch (err) {
        console.error("[chat-send] ERROR reading attachment:", err);
      }
    }

    console.log(
      `[chat-send]\n` +
        `projectId=${projectId}\n` +
        `hasText=${Boolean(currentText)}\n` +
        `textLength=${currentText.length}\n` +
        `hasAttachment=${Boolean(attachment)}\n` +
        `filename=${attachment?.filename ?? "none"}\n` +
        `mimeType=${attachment?.mimeType ?? "none"}`,
    );

    setText("");
    setFile(undefined);
    if (fileInputRef.current) fileInputRef.current.value = "";
    await send(currentText, attachment);
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel-header">
        <div>
          <h3>Project Chat</h3>
          <p className="field-hint">Ask CodeForge about this project, analyse work, understand the codebase, or prepare tasks.</p>
        </div>
        <span className="chat-context-indicator">● Using project context</span>
      </div>

      <div className="chat-messages" aria-live="polite">
        {loading && <p className="field-hint">Loading conversation…</p>}
        {error && <ErrorState message="Couldn't load the conversation." />}
        {!loading && !error && (messages ?? []).length === 0 && (
          <div className="chat-empty-state">
            <h4>What can I help with?</h4>
            <div className="chat-suggestion-chips">
              {SUGGESTION_CHIPS.map((chip) => (
                <button key={chip} type="button" className="chat-suggestion-chip" onClick={() => setText(chip)}>
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        {(messages ?? []).map((m) => (
          <div key={m.id} className={`chat-message chat-message-${m.role}`}>
            <div className="chat-message-meta">
              <strong>{m.role === "user" ? "You" : "CodeForge"}</strong> <span className="field-hint">{formatRelative(m.createdAt)}</span>
            </div>
            {m.attachment && <div className="field-hint">📎 {m.attachment.filename}</div>}
            <div className="chat-message-content">{m.content}</div>
            {m.role === "assistant" && m.bulkJobId && <TaskSuggestions projectId={projectId} bulkJobId={m.bulkJobId} />}
          </div>
        ))}
        {sending && <p className="field-hint">CodeForge is thinking…</p>}
        {/* Phase 4D.3 — a proposed bulk mutation ("cancel all failed tasks"), or (Phase 4D.4) a single
            task's human-confirmed Review -> Done completion, waits here for an explicit yes/no; the
            buttons send that same plain text through the SAME sendMessage path a typed reply would use —
            never a second mutation endpoint. */}
        {pendingAction && !sending && (
          <div className="chat-pending-action">
            <span>
              {pendingAction.kind === "HUMAN_MARK_DONE"
                ? `Mark "${pendingAction.taskTitle}" as Done?`
                : pendingAction.kind === "UPLOAD_TASK_CREATION"
                ? `Create ${pendingAction.itemIds.length} task${pendingAction.itemIds.length === 1 ? "" : "s"} (${pendingAction.filterDescription})?`
                : `${pendingAction.kind === "BULK_CANCEL" ? "Cancel" : "Start"} ${pendingAction.taskIds?.length ?? 0} task${pendingAction.taskIds?.length === 1 ? "" : "s"}?`}
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void confirmPendingAction()}>
              {pendingAction.kind === "HUMAN_MARK_DONE"
                ? "Mark as Done"
                : pendingAction.kind === "UPLOAD_TASK_CREATION"
                ? "Create Tasks"
                : "Confirm"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void declinePendingAction()}>
              {pendingAction.kind === "HUMAN_MARK_DONE" || pendingAction.kind === "UPLOAD_TASK_CREATION" ? "Cancel" : "Decline"}
            </button>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {sendError && <ErrorState message={sendError} />}

      <form className="chat-composer" onSubmit={handleSubmit}>
        {file && (
          <div className="chat-attachment-chip">
            {previewUrl ? <img src={previewUrl} alt="" className="chat-attachment-thumb" /> : <span>📎</span>}
            <span>{file.name}</span>
            <button type="button" className="chat-attachment-remove" onClick={() => handleFileChange(undefined)} aria-label="Remove attachment">
              ×
            </button>
          </div>
        )}
        {fileError && <p className="field-hint danger">{fileError}</p>}
        <div className="chat-composer-row">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(",")}
            onChange={(e) => handleFileChange(e.target.files?.[0])}
            aria-label="Attach a file"
            className="chat-file-input-hidden"
          />
          <button type="button" className="chat-attach-btn" onClick={() => fileInputRef.current?.click()} aria-label="Add attachment" title="Attach a file">
            ＋
          </button>
          <textarea
            rows={1}
            placeholder="Ask CodeForge…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit(e as unknown as FormEvent);
              }
            }}
          />
          <button type="submit" className="btn btn-primary chat-send-btn" disabled={sending || (!text.trim() && !file)}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
