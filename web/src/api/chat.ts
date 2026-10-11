import { apiClient } from "./client.js";
import type { ChatAttachmentDTO, ChatMessageDTO, ChatPendingActionDTO, ChatSuggestionDTO, CreateTasksFromChatResponseDTO, SendChatMessageResponseDTO } from "./types.js";

/** Image extensions that should be uploaded via the binary attachment endpoint (too large for inline base64 in JSON). */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function isImageAttachment(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

interface UploadAttachmentResponse {
  attachmentId: string;
  filename: string;
  byteSize: number;
}

/** Phase 4C — Chat, inside Overview. See /docs/API.md "Chat". */
export const chatApi = {
  listMessages: (projectId: string) => apiClient.get<{ messages: ChatMessageDTO[]; pendingAction: ChatPendingActionDTO | null }>(`/projects/${projectId}/chat/messages`),

  /**
   * Phase 4D.7 — upload a binary attachment. Returns an `attachmentId` the client passes in the
   * subsequent sendMessage call. Used for images/large files that would exceed the JSON body limit.
   */
  uploadAttachment: (projectId: string, file: File): Promise<UploadAttachmentResponse> => {
    return file.arrayBuffer().then((buf) =>
      apiClient.postBinary<UploadAttachmentResponse>(
        `/projects/${projectId}/chat/attachments`,
        buf,
        { filename: file.name, mimeType: file.type || "application/octet-stream" },
      ),
    );
  },

  /**
   * Send a chat message. For image attachments, the caller should upload via `uploadAttachment` first
   * and pass `attachmentId` instead of `attachment`. For small text/CSV files, inline base64 still works.
   */
  sendMessage: (projectId: string, input: { text: string; attachment?: ChatAttachmentDTO; attachmentId?: string }) => {
    const clientRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[chat-send] clientRequestId=${clientRequestId} url=/api/projects/${projectId}/chat/messages`);
    return apiClient.post<SendChatMessageResponseDTO>(`/projects/${projectId}/chat/messages`, input, {
      "x-codeforge-client-request-id": clientRequestId,
    });
  },

  listSuggestions: (projectId: string, bulkJobId: string) =>
    apiClient.get<{ suggestions: ChatSuggestionDTO[] }>(`/projects/${projectId}/chat/suggestions/${bulkJobId}`).then((r) => r.suggestions),
  createTasks: (projectId: string, itemIds: string[]) => apiClient.post<CreateTasksFromChatResponseDTO>(`/projects/${projectId}/chat/create-tasks`, { itemIds }),
};
