import { useCallback, useEffect, useState } from "react";
import { chatApi } from "../api/index.js";
import type { ChatAttachmentDTO, ChatMessageDTO, ChatPendingActionDTO } from "../api/types.js";

/**
 * Backs the Chat panel inside Overview (Phase 4C). A plain fetch-once-then-append model — unlike the
 * task board's usePolling, a chat turn is a synchronous request/response (the assistant message comes
 * back in the SAME response as the user message), so there is nothing to poll for here.
 *
 * Phase 4D.3 — `pendingAction` mirrors the conversation's own stored bulk-mutation proposal (see
 * migration 024's own doc comment). `confirm`/`decline` are NOT a second mutation path — they just send
 * the plain "yes"/"no" text through the SAME `send` a typed reply would use.
 */
export function useChat(projectId: string) {
  const [messages, setMessages] = useState<ChatMessageDTO[]>();
  const [pendingAction, setPendingAction] = useState<ChatPendingActionDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();

  const load = useCallback(() => {
    setLoading(true);
    setError(undefined);
    chatApi
      .listMessages(projectId)
      .then((r) => {
        setMessages(r.messages);
        setPendingAction(r.pendingAction);
      })
      .catch((err) => setError(err instanceof Error ? err : new Error("Couldn't load the conversation.")))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(load, [load]);

  const send = useCallback(
    async (text: string, attachment?: ChatAttachmentDTO, attachmentId?: string, attachmentMeta?: { filename: string; mimeType: string }) => {
      setSending(true);
      setSendError(undefined);

      // Standard chat behavior: show the user's own message the instant they hit Send, not only once the
      // assistant's reply comes back — the server's real `userMessage` (with its real id) replaces this
      // placeholder on success; on failure it's removed, since `sendError` already surfaces the failure.
      const optimisticId = `optimistic-${Date.now()}`;
      // Phase 4D.7 — for the binary upload path (attachmentId), use attachmentMeta for display; for the
      // inline base64 path (CSV/XLSX/TXT) use attachment — never both at once.
      const optimisticAttachmentDisplay = attachment
        ? { filename: attachment.filename, mimeType: attachment.mimeType, byteSize: 0 }
        : attachmentMeta
        ? { filename: attachmentMeta.filename, mimeType: attachmentMeta.mimeType, byteSize: 0 }
        : null;
      const optimisticMessage: ChatMessageDTO = {
        id: optimisticId,
        conversationId: "",
        role: "user",
        content: text || (optimisticAttachmentDisplay ? `(attached ${optimisticAttachmentDisplay.filename})` : ""),
        attachment: optimisticAttachmentDisplay,
        bulkJobId: null,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...(prev ?? []), optimisticMessage]);

      try {
        const { userMessage, assistantMessage, pendingAction: nextPending } = await chatApi.sendMessage(projectId, { text, attachment, attachmentId });
        setMessages((prev) => [...(prev ?? []).filter((m) => m.id !== optimisticId), userMessage, assistantMessage]);
        setPendingAction(nextPending);
        return assistantMessage;
      } catch (err) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== optimisticId));
        setSendError(err instanceof Error ? err.message : "That message couldn't be sent. Please try again.");
        return undefined;
      } finally {
        setSending(false);
      }
    },
    [projectId],
  );

  const confirmPendingAction = useCallback(() => send("yes"), [send]);
  const declinePendingAction = useCallback(() => send("no"), [send]);

  return { messages, pendingAction, loading, error, refetch: load, send, sending, sendError, confirmPendingAction, declinePendingAction };
}
