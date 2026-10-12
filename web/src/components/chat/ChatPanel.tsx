import { useEffect, useRef, useState, type FormEvent } from "react";
import { useChat } from "../../hooks/useChat.js";
import { chatApi } from "../../api/index.js";
import { formatRelative } from "../../lib/time.js";
import { ErrorState } from "../common/ErrorState.js";
import { TaskSuggestions } from "./TaskSuggestions.js";
import { CoinsIcon, PaperclipIcon, SendHorizontalIcon, SparklesIcon, UserIcon, XIcon } from "lucide-react";
import { tokenLabel } from "../../lib/tokens.js";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

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
export function ChatPanel({ projectId, onReply }: { projectId: string; /** Called after each answered message (e.g. to refresh the token meter). */ onReply?: () => void }) {
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
      onReply?.();
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
    onReply?.();
  }

  return (
    <div className="flex h-full min-h-[560px] flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <SparklesIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="font-semibold">Project Chat</h3>
            <p className="text-sm text-muted-foreground">
              Ask CodeForge about this project, analyse work, understand the codebase, or prepare tasks.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-tone-success/12 px-2.5 py-1 text-xs font-medium text-tone-success">
          <span className="size-1.5 rounded-full bg-tone-success" aria-hidden="true" />
          Using project context
        </span>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5" aria-live="polite">
        {loading && <p className="text-sm text-muted-foreground">Loading conversation…</p>}
        {error && <ErrorState message="Couldn't load the conversation." />}
        {!loading && !error && (messages ?? []).length === 0 && (
          <div className="flex flex-col items-center justify-center gap-5 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <SparklesIcon className="size-5" aria-hidden="true" />
            </span>
            <h4 className="text-lg font-semibold">What can I help with?</h4>
            <div className="flex max-w-lg flex-wrap justify-center gap-2">
              {SUGGESTION_CHIPS.map((chip) => (
                <Button key={chip} type="button" variant="outline" size="sm" onClick={() => setText(chip)}>
                  {chip}
                </Button>
              ))}
            </div>
          </div>
        )}
        {(messages ?? []).map((m) => {
          const isUser = m.role === "user";
          return (
            <div key={m.id} className={cn("flex gap-3", isUser && "flex-row-reverse")}>
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  isUser ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground",
                )}
                aria-hidden="true"
              >
                {isUser ? <UserIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
              </span>
              <div className={cn("flex max-w-[85%] min-w-0 flex-col gap-1", isUser && "items-end")}>
                <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                  <strong className="font-medium text-foreground">{isUser ? "You" : "CodeForge"}</strong>
                  <span>{formatRelative(m.createdAt)}</span>
                </div>
                {m.attachment && (
                  <div className="rounded-lg border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
                    📎 {m.attachment.filename}
                  </div>
                )}
                <div
                  className={cn(
                    "rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap",
                    isUser ? "rounded-tr-sm bg-primary text-primary-foreground" : "rounded-tl-sm bg-muted",
                  )}
                >
                  {m.content}
                </div>
                {m.role === "assistant" && m.bulkJobId && <TaskSuggestions projectId={projectId} bulkJobId={m.bulkJobId} />}
                {m.role === "assistant" && typeof m.tokens === "number" && (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <CoinsIcon className="size-3" aria-hidden="true" />
                    {m.tokens === 0 ? "No AI tokens used — answered from CodeForge data" : `Used ${tokenLabel(m.tokens, !!m.tokensEstimated)}`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {sending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> CodeForge is thinking…
          </p>
        )}
        {/* Phase 4D.3 — a proposed bulk mutation ("cancel all failed tasks"), or (Phase 4D.4) a single
            task's human-confirmed Review -> Done completion, waits here for an explicit yes/no; the
            buttons send that same plain text through the SAME sendMessage path a typed reply would use —
            never a second mutation endpoint. */}
        {pendingAction && !sending && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-tone-attention/40 bg-tone-attention/10 px-4 py-3 text-sm">
            <span className="flex-1 font-medium">
              {pendingAction.kind === "HUMAN_MARK_DONE"
                ? `Mark "${pendingAction.taskTitle}" as Done?`
                : pendingAction.kind === "UPLOAD_TASK_CREATION"
                ? `Create ${pendingAction.itemIds.length} task${pendingAction.itemIds.length === 1 ? "" : "s"} (${pendingAction.filterDescription})?`
                : `${pendingAction.kind === "BULK_CANCEL" ? "Cancel" : "Start"} ${pendingAction.taskIds?.length ?? 0} task${pendingAction.taskIds?.length === 1 ? "" : "s"}?`}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void declinePendingAction().then(() => onReply?.())}>
                {pendingAction.kind === "HUMAN_MARK_DONE" || pendingAction.kind === "UPLOAD_TASK_CREATION" ? "Cancel" : "Decline"}
              </Button>
              <Button type="button" size="sm" onClick={() => void confirmPendingAction().then(() => onReply?.())}>
                {pendingAction.kind === "HUMAN_MARK_DONE"
                  ? "Mark as Done"
                  : pendingAction.kind === "UPLOAD_TASK_CREATION"
                  ? "Create Tasks"
                  : "Confirm"}
              </Button>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {sendError && (
        <div className="px-5 pb-3">
          <ErrorState message={sendError} />
        </div>
      )}

      <form className="border-t p-3" onSubmit={handleSubmit}>
        <div className="rounded-3xl border bg-input/20 p-2 transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          {file && (
            <div className="mb-2 inline-flex max-w-full items-center gap-2 rounded-xl border bg-background py-1 pr-1 pl-2 text-xs">
              {previewUrl ? (
                <img src={previewUrl} alt="" className="size-8 rounded-md object-cover" />
              ) : (
                <PaperclipIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="truncate">{file.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => handleFileChange(undefined)}
                aria-label="Remove attachment"
              >
                <XIcon />
              </Button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(",")}
            onChange={(e) => handleFileChange(e.target.files?.[0])}
            aria-label="Attach a file"
            className="sr-only"
          />
          <textarea
            rows={2}
            placeholder="Ask CodeForge…"
            value={text}
            className="block max-h-48 min-h-12 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit(e as unknown as FormEvent);
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Add attachment"
              title="Attach a file"
            >
              <PaperclipIcon />
            </Button>
            <Button type="submit" size="sm" disabled={sending || (!text.trim() && !file)}>
              {sending ? "Sending…" : "Send"}
              {!sending && <SendHorizontalIcon data-icon="inline-end" />}
            </Button>
          </div>
        </div>
        {fileError && <p className="mt-2 px-2 text-sm text-destructive">{fileError}</p>}
      </form>
    </div>
  );
}
