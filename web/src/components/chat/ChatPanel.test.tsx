import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ChatPanel } from "./ChatPanel.js";
import { chatApi } from "../../api/index.js";

vi.mock("../../api/chat.js", () => ({
  chatApi: { listMessages: vi.fn(), sendMessage: vi.fn(), uploadAttachment: vi.fn(), listSuggestions: vi.fn(), createTasks: vi.fn() },
}));

const mockedChatApi = vi.mocked(chatApi);

function renderPanel() {
  return render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
}

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedChatApi.listMessages.mockResolvedValue({ messages: [], pendingAction: null });
  });

  it("shows the persistent 'Project Chat' heading and a project-context indicator", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project Chat" })).toBeInTheDocument());
    expect(screen.getByText(/using project context/i)).toBeInTheDocument();
    // No technical internals in the context indicator.
    expect(screen.queryByText(/opencode|provider|model/i)).not.toBeInTheDocument();
  });

  it("shows a compact empty-state prompt with suggestion chips that fill the composer", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByRole("heading", { name: "What can I help with?" })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Explain this project" }));
    expect(screen.getByPlaceholderText(/ask codeforge/i)).toHaveValue("Explain this project");
  });

  it("sends a plain text message and renders both the user and assistant turns", async () => {
    mockedChatApi.sendMessage.mockResolvedValue({
      userMessage: { id: "u1", conversationId: "c1", role: "user", content: "Explain OTP", attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:00.000Z" },
      assistantMessage: { id: "a1", conversationId: "c1", role: "assistant", content: "OTP codes expire in 5 minutes.", attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:01.000Z" },
      pendingAction: null,
    });
    renderPanel();
    await waitFor(() => expect(screen.getByPlaceholderText(/ask codeforge/i)).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText(/ask codeforge/i), "Explain OTP");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(mockedChatApi.sendMessage).toHaveBeenCalledWith("p1", { text: "Explain OTP", attachment: undefined, attachmentId: undefined });
    await waitFor(() => expect(screen.getByText("Explain OTP")).toBeInTheDocument());
    expect(screen.getByText("OTP codes expire in 5 minutes.")).toBeInTheDocument();
  });

  it("shows a 'Show suggestions' control under an assistant message that started a bulk analysis run, and none for a plain reply", async () => {
    mockedChatApi.listMessages.mockResolvedValue({
      messages: [
        { id: "u1", conversationId: "c1", role: "user", content: "analyze this", attachment: { filename: "bugs.csv", mimeType: "text/csv", byteSize: 100 }, bulkJobId: null, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "a1", conversationId: "c1", role: "assistant", content: "Imported 3 of 3 rows.", attachment: null, bulkJobId: "bulk-1", createdAt: "2026-01-01T00:00:01.000Z" },
      ],
      pendingAction: null,
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText("Imported 3 of 3 rows.")).toBeInTheDocument());
    expect(screen.getByText("📎 bugs.csv")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show suggestions" })).toBeInTheDocument();
  });

  it("clicking 'Show suggestions' loads suggestions and 'Create selected tasks' calls createTasks — nothing is created automatically", async () => {
    mockedChatApi.listMessages.mockResolvedValue({
      messages: [{ id: "a1", conversationId: "c1", role: "assistant", content: "Imported 1 of 1 rows.", attachment: null, bulkJobId: "bulk-1", createdAt: "2026-01-01T00:00:01.000Z" }],
      pendingAction: null,
    });
    mockedChatApi.listSuggestions.mockResolvedValue([{ itemId: "item-1", ref: "BUG-1", title: "Broken thing", status: "READY_FOR_TASK", proposal: null }]);
    mockedChatApi.createTasks.mockResolvedValue({ createdTaskIds: ["task-1"], results: [{ itemId: "item-1", ok: true, detail: "task created (BACKLOG — not started)", taskId: "task-1" }] });
    renderPanel();

    await waitFor(() => expect(screen.getByRole("button", { name: "Show suggestions" })).toBeInTheDocument());
    // No suggestion/task work happens until the user explicitly asks.
    expect(mockedChatApi.listSuggestions).not.toHaveBeenCalled();
    expect(mockedChatApi.createTasks).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Show suggestions" }));
    await waitFor(() => expect(screen.getByText("Broken thing")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /create selected tasks/i }));
    await waitFor(() => expect(mockedChatApi.createTasks).toHaveBeenCalledWith("p1", ["item-1"]));
    await waitFor(() => expect(screen.getByText(/1 task created in/i)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Tasks → BACKLOG" })).toBeInTheDocument();
  });

  it("Phase 4D.3: a pending bulk-action proposal renders Confirm/Decline buttons that send the SAME plain yes/no text through sendMessage", async () => {
    mockedChatApi.listMessages.mockResolvedValue({
      messages: [{ id: "a1", conversationId: "c1", role: "assistant", content: 'I found 2 tasks in Failed: "A", "B". Cancel all of them?', attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:01.000Z" }],
      pendingAction: { kind: "BULK_CANCEL", status: "FAILED", taskIds: ["t1", "t2"], titles: ["A", "B"], createdAt: "2026-01-01T00:00:01.000Z" },
    });
    mockedChatApi.sendMessage.mockResolvedValue({
      userMessage: { id: "u2", conversationId: "c1", role: "user", content: "yes", attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:02.000Z" },
      assistantMessage: { id: "a2", conversationId: "c1", role: "assistant", content: "Cancelled 2 of 2 tasks.", attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:03.000Z" },
      pendingAction: null,
    });
    renderPanel();

    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mockedChatApi.sendMessage).toHaveBeenCalledWith("p1", { text: "yes", attachment: undefined, attachmentId: undefined });
    await waitFor(() => expect(screen.getByText("Cancelled 2 of 2 tasks.")).toBeInTheDocument());
    // Confirmed proposal is cleared — buttons disappear.
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  });

  it("Phase 4D.4: a pending human-completion proposal renders 'Mark as Done'/'Cancel' buttons that send the SAME plain yes/no text", async () => {
    mockedChatApi.listMessages.mockResolvedValue({
      messages: [{ id: "a1", conversationId: "c1", role: "assistant", content: '"Fix login" is currently in Review.\n\nDo you want me to mark it as Done?', attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:01.000Z" }],
      pendingAction: { kind: "HUMAN_MARK_DONE", taskId: "t1", taskTitle: "Fix login", observedStatus: "REVIEW", createdAt: "2026-01-01T00:00:01.000Z" },
    });
    mockedChatApi.sendMessage.mockResolvedValue({
      userMessage: { id: "u2", conversationId: "c1", role: "user", content: "yes", attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:02.000Z" },
      assistantMessage: { id: "a2", conversationId: "c1", role: "assistant", content: '✓ "Fix login" is now Done.', attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:03.000Z" },
      pendingAction: null,
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Mark "Fix login" as Done?')).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Mark as Done" }));

    expect(mockedChatApi.sendMessage).toHaveBeenCalledWith("p1", { text: "yes", attachment: undefined, attachmentId: undefined });
    await waitFor(() => expect(screen.getByText('✓ "Fix login" is now Done.')).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Mark as Done" })).not.toBeInTheDocument();
  });

  it("shows a send error without losing the composed text state silently", async () => {
    mockedChatApi.sendMessage.mockRejectedValue(new Error("The model is unavailable."));
    renderPanel();
    await waitFor(() => expect(screen.getByPlaceholderText(/ask codeforge/i)).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText(/ask codeforge/i), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("The model is unavailable.")).toBeInTheDocument());
  });

  it("rejects an unsupported attachment type client-side before ever sending", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByLabelText(/attach a file/i)).toBeInTheDocument());

    // userEvent.upload respects the input's `accept` filter and silently refuses a mismatched file —
    // fireEvent bypasses that so this test exercises ChatPanel's OWN validation, not the browser's.
    const file = new File(["bad"], "malware.exe", { type: "application/octet-stream" });
    fireEvent.change(screen.getByLabelText(/attach a file/i), { target: { files: [file] } });

    expect(screen.getByText(/unsupported file type/i)).toBeInTheDocument();
    expect(mockedChatApi.sendMessage).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Phase 4D.7 — image binary upload path
  // ---------------------------------------------------------------------------

  it("Phase 4D.7: image attachment calls uploadAttachment() first, then sendMessage with attachmentId — never sends contentBase64", async () => {
    mockedChatApi.uploadAttachment.mockResolvedValue({ attachmentId: "att-uuid-1", filename: "shot.png", byteSize: 12345 });
    mockedChatApi.sendMessage.mockResolvedValue({
      userMessage: { id: "u1", conversationId: "c1", role: "user", content: "(attached shot.png)", attachment: { filename: "shot.png", mimeType: "image/png", byteSize: 12345 }, bulkJobId: null, createdAt: "2026-01-01T00:00:00.000Z" },
      assistantMessage: { id: "a1", conversationId: "c1", role: "assistant", content: "CodeForge doesn't support image analysis.", attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:01.000Z" },
      pendingAction: null,
    });

    renderPanel();
    await waitFor(() => expect(screen.getByLabelText(/attach a file/i)).toBeInTheDocument());

    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/attach a file/i), { target: { files: [pngFile] } });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    // uploadAttachment must have been called with the image file
    expect(mockedChatApi.uploadAttachment).toHaveBeenCalledWith("p1", pngFile);

    // sendMessage receives attachmentId, not contentBase64
    await waitFor(() => expect(mockedChatApi.sendMessage).toHaveBeenCalled());
    const [, msgBody] = mockedChatApi.sendMessage.mock.calls[0] as [string, { text: string; attachment?: { contentBase64?: string }; attachmentId?: string }];
    expect(msgBody.attachmentId).toBe("att-uuid-1");
    expect(msgBody.attachment?.contentBase64).toBeUndefined();
  });

  it("Phase 4D.7: text + image together — text is included in sendMessage and attachmentId is set", async () => {
    mockedChatApi.uploadAttachment.mockResolvedValue({ attachmentId: "att-uuid-2", filename: "screen.png", byteSize: 8000 });
    mockedChatApi.sendMessage.mockResolvedValue({
      userMessage: { id: "u1", conversationId: "c1", role: "user", content: "What is this?", attachment: { filename: "screen.png", mimeType: "image/png", byteSize: 8000 }, bulkJobId: null, createdAt: "2026-01-01T00:00:00.000Z" },
      assistantMessage: { id: "a1", conversationId: "c1", role: "assistant", content: "No vision model available.", attachment: null, bulkJobId: null, createdAt: "2026-01-01T00:00:01.000Z" },
      pendingAction: null,
    });

    renderPanel();
    await waitFor(() => expect(screen.getByLabelText(/attach a file/i)).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText(/ask codeforge/i), "What is this?");
    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screen.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/attach a file/i), { target: { files: [pngFile] } });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(mockedChatApi.sendMessage).toHaveBeenCalled());
    const [, msgBody] = mockedChatApi.sendMessage.mock.calls[0] as [string, { text: string; attachmentId?: string }];
    expect(msgBody.text).toBe("What is this?");
    expect(msgBody.attachmentId).toBe("att-uuid-2");
  });

  it("Phase 4D.7: image upload failure does NOT send chat message, and shows an upload error", async () => {
    mockedChatApi.uploadAttachment.mockRejectedValue(new Error("Network timeout"));

    renderPanel();
    await waitFor(() => expect(screen.getByLabelText(/attach a file/i)).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText(/ask codeforge/i), "What is this?");
    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "error.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/attach a file/i), { target: { files: [pngFile] } });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    // sendMessage must NOT have been called
    await waitFor(() => expect(screen.getByText(/upload failed/i)).toBeInTheDocument());
    expect(mockedChatApi.sendMessage).not.toHaveBeenCalled();
    // Text is restored so user doesn't lose their message
    expect(screen.getByPlaceholderText(/ask codeforge/i)).toHaveValue("What is this?");
  });

  it("Phase 4D.7: CSV file continues to use the inline base64 path (not uploadAttachment)", async () => {
    mockedChatApi.sendMessage.mockResolvedValue({
      userMessage: { id: "u1", conversationId: "c1", role: "user", content: "(attached bugs.csv)", attachment: { filename: "bugs.csv", mimeType: "text/csv", byteSize: 50 }, bulkJobId: null, createdAt: "2026-01-01T00:00:00.000Z" },
      assistantMessage: { id: "a1", conversationId: "c1", role: "assistant", content: "Imported 3 rows.", attachment: null, bulkJobId: "bulk-1", createdAt: "2026-01-01T00:00:01.000Z" },
      pendingAction: null,
    });

    renderPanel();
    await waitFor(() => expect(screen.getByLabelText(/attach a file/i)).toBeInTheDocument());

    // CSV — not an image, must go through readFileAsBase64 / inline path
    const csvFile = new File(["bugId,title\n1,Something broke"], "bugs.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(/attach a file/i), { target: { files: [csvFile] } });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    // uploadAttachment must NOT have been called for CSV
    expect(mockedChatApi.uploadAttachment).not.toHaveBeenCalled();

    // sendMessage must have been called with attachment.contentBase64 (not attachmentId)
    await waitFor(() => expect(mockedChatApi.sendMessage).toHaveBeenCalled());
    const [, msgBody] = mockedChatApi.sendMessage.mock.calls[0] as [string, { attachmentId?: string; attachment?: { contentBase64?: string } }];
    expect(msgBody.attachmentId).toBeUndefined();
    expect(msgBody.attachment?.contentBase64).toBeDefined();
  });
});
