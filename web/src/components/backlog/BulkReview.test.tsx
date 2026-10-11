import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { BulkReviewPanel } from "./BulkReviewPanel.js";
import { ImportBugsDialog } from "./ImportBugsDialog.js";
import type { BulkReviewDTO, ReviewRowDTO } from "../../api/index.js";

vi.mock("../../api/bulkBacklog.js", () => ({
  bulkBacklogApi: {
    review: vi.fn(),
    groups: vi.fn(),
    startAnalysis: vi.fn(),
    cancelBulk: vi.fn(),
    action: vi.fn(),
    preview: vi.fn(),
    confirmImport: vi.fn(),
    reviewRelationship: vi.fn(),
  },
}));
import { bulkBacklogApi as api } from "../../api/bulkBacklog.js";

const row = (over: Partial<ReviewRowDTO> = {}): ReviewRowDTO => ({
  itemId: "i1", ref: "app:BUG-1", title: "No limit on OTP", status: "ANALYZED", module: "SignUp", priority: "High",
  analysis: { state: "SUCCEEDED", failureCategory: null, failureReason: null, completedAt: "t" },
  review: { state: "POSSIBLY_ALREADY_IMPLEMENTED", implementation: "present", behavior: "BEHAVIOR_UNVERIFIED" },
  flow: "FLOW_REFERENCE_PRESENT", evidenceCount: 4, verification: { checksAvailable: 1, sufficientChecks: 0, verified: false },
  duplicates: { proposed: 1, confirmed: 0 }, dependencies: { proposed: 0, confirmed: 0 }, proposal: null,
  usage: { inputTokens: null, outputTokens: null, estimatedCost: null, status: "unavailable" }, ...over,
});
const dto = (rows: ReviewRowDTO[]): BulkReviewDTO => ({
  rows, total: rows.length,
  counts: { all: rows.length, needs_analysis: 0, analysis_ready: rows.length, possibly_implemented: 1, needs_clarification: 0, duplicate: 1, dependency: 0, ready_for_proposal: 0, verified: rows.filter((r) => r.verification.verified).length, unverified: rows.length, failed: 0 },
  usage: { analyses: rows.length, withReportedUsage: 0, unavailable: rows.length, partial: 0, inputTokens: 0, outputTokens: 0, estimatedCost: [] },
});
const renderPanel = () => render(<MemoryRouter><BulkReviewPanel projectId="p1" onOpenImport={() => {}} /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.groups).mockResolvedValue({ duplicateGroups: [], dependencies: [] });
});

describe("Bulk review", () => {
  it("shows implementation, flow and behavior as separate facts and NEVER 'Verified' for an unverified row", async () => {
    vi.mocked(api.review).mockResolvedValue(dto([row()]));
    renderPanel();
    await screen.findByText("No limit on OTP");
    const table = screen.getByRole("table");
    expect(within(table).getByText("Flow reference present")).toBeInTheDocument();
    expect(within(table).getByText(/Behavior unverified/)).toBeInTheDocument();
    expect(within(table).queryByText(/Verified by a platform check/)).not.toBeInTheDocument();
    expect(within(table).queryByText(/fixed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/1 unavailable/)).toBeInTheDocument();
  });

  it("'Verified by a platform check' appears only when the server says the row is genuinely verified", async () => {
    vi.mocked(api.review).mockResolvedValue(dto([row({ verification: { checksAvailable: 1, sufficientChecks: 1, verified: true }, review: { state: "VERIFIED_CONFLICT", implementation: "present", behavior: "CHECK_VERIFIED" } })]));
    renderPanel();
    expect((await screen.findAllByText(/Verified by a platform check/)).length).toBeGreaterThan(0);
  });

  it("offers the review filters with counts and reloads on change", async () => {
    vi.mocked(api.review).mockResolvedValue(dto([row()]));
    renderPanel();
    await screen.findByText("No limit on OTP");
    expect(screen.getByRole("tab", { name: /Duplicate candidate \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Possibly already implemented \(1\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Failed/ }));
    await waitFor(() => expect(api.review).toHaveBeenLastCalledWith("p1", "failed"));
  });

  it("Analyze selected only enqueues; there is no Start/Execute-all control anywhere", async () => {
    vi.mocked(api.review).mockResolvedValue(dto([row()]));
    vi.mocked(api.startAnalysis).mockResolvedValue({ created: true, bulk: { job: { id: "b1", importId: null, totalItems: 1, cancelRequestedAt: null, createdAt: "t" }, status: "QUEUED", counts: { total: 1, queued: 1, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 }, members: [] } });
    renderPanel();
    await screen.findByText("No limit on OTP");
    expect(screen.getByRole("button", { name: /Analyze selected \(0\)/ })).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Select app:BUG-1"));
    await userEvent.click(screen.getByRole("button", { name: /Analyze selected \(1\)/ }));
    await waitFor(() => expect(api.startAnalysis).toHaveBeenCalledWith("p1", { itemIds: ["i1"] }));
    expect(await screen.findByText(/Nothing else runs until you approve/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start all|execute all|auto/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel bulk analysis/ })).toBeInTheDocument();
  });

  it("bulk actions report per-item success/failure without hiding failures", async () => {
    vi.mocked(api.review).mockResolvedValue(dto([row()]));
    vi.mocked(api.action).mockResolvedValue({ ok: 1, failed: 1, results: [{ itemId: "i1", ok: true, detail: "x" }, { itemId: "i2", ok: false, detail: "This item has no live proposal." }] });
    renderPanel();
    await screen.findByText("No limit on OTP");
    await userEvent.click(screen.getByLabelText("Select app:BUG-1"));
    await userEvent.click(screen.getByRole("button", { name: "Convert approved to tasks" }));
    expect(await screen.findByText(/Convert: 1 succeeded, 1 failed — This item has no live proposal\./)).toBeInTheDocument();
  });
});

describe("Import dialog", () => {
  const preview = { headers: ["Bug title"], mapping: { fields: { title: "Bug title" }, metadataColumns: [], unnamedColumns: 0 }, totalRows: 3, accepted: 2, rejected: 1, alreadyImported: 0, warnings: [], errors: [], rows: [{ rowNumber: 4, status: "REJECTED" as const, reason: "missing_title", detail: "The title is empty.", sourceKey: null, title: null, warnings: [] }] };

  it("previews first (rejected rows explained), then imports only on confirmation; import never analyzes", async () => {
    vi.mocked(api.preview).mockResolvedValue(preview);
    vi.mocked(api.confirmImport).mockResolvedValue({ id: "imp", sourceName: "S", totalRows: 3, acceptedRows: 2, rejectedRows: 1, alreadyImportedRows: 0, createdAt: "t" });
    const onImported = vi.fn();
    render(<ImportBugsDialog projectId="p1" onClose={() => {}} onImported={onImported} />);
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("…or paste CSV"), "Bug title,Description\nA,b\n");
    await userEvent.type(screen.getByLabelText("Source name"), "S");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/3 rows:/)).toBeInTheDocument();
    expect(screen.getByText(/Missing title/)).toBeInTheDocument();
    expect(api.confirmImport).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Import 2 valid rows" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(api.startAnalysis).not.toHaveBeenCalled();
  });
});
