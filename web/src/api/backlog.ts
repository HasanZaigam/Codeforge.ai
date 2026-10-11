import { apiClient } from "./client.js";
import type {
  BacklogAnalysisJobDTO,
  BacklogItemDetailDTO,
  BacklogItemDTO,
  BacklogItemSummaryDTO,
  ClaimVerificationJobDTO,
  ConvertProposalResult,
  CreateBacklogItemInput,
  TaskProposalDTO,
  UpdateBacklogItemInput,
} from "./types.js";

/**
 * Phase 4A Backlog Intelligence — see /docs/API.md "Backlog". Every action endpoint takes an empty
 * body (the server rejects any extra key); no call here can set a status, only request a transition.
 */
export const backlogApi = {
  list: (projectId: string) =>
    apiClient.get<{ items: BacklogItemSummaryDTO[] }>(`/projects/${projectId}/backlog`).then((r) => r.items),
  create: (projectId: string, input: CreateBacklogItemInput) =>
    apiClient.post<{ item: BacklogItemDTO }>(`/projects/${projectId}/backlog`, input).then((r) => r.item),
  get: (itemId: string) => apiClient.get<BacklogItemDetailDTO>(`/backlog/${itemId}`),
  update: (itemId: string, input: UpdateBacklogItemInput) =>
    apiClient.patch<{ item: BacklogItemDTO }>(`/backlog/${itemId}`, input).then((r) => r.item),
  reject: (itemId: string) => apiClient.post<{ item: BacklogItemDTO }>(`/backlog/${itemId}/reject`, {}).then((r) => r.item),
  /**
   * 202 — only ENQUEUES a job (idempotent: `enqueued: false` when one is already live); a worker runs it,
   * so poll `get` until the item leaves ANALYZING.
   */
  analyze: (itemId: string) =>
    apiClient.post<{ item: BacklogItemDTO; job: BacklogAnalysisJobDTO; enqueued: boolean }>(`/backlog/${itemId}/analyze`, {}),
  /** 202 — a QUEUED job is cancelled at once; a RUNNING one gets cancelRequested and stops at its next heartbeat. */
  cancelAnalysis: (itemId: string) =>
    apiClient.post<{ item: BacklogItemDTO; job: BacklogAnalysisJobDTO }>(`/backlog/${itemId}/analysis/cancel`, {}),
  /** 202 — only ENQUEUES worker jobs for the approved checks bound to this analysis (idempotent); poll `get`. `jobs: []` + `note` when none is bound. */
  requestVerification: (itemId: string) =>
    apiClient.post<{ jobs: ClaimVerificationJobDTO[]; enqueued: number; revision: string; note: string | null }>(`/backlog/${itemId}/verifications`, {}),
  cancelVerification: (itemId: string, jobId: string) =>
    apiClient.post<{ job: ClaimVerificationJobDTO }>(`/backlog/${itemId}/verifications/${jobId}/cancel`, {}).then((r) => r.job),
  generateProposal: (itemId: string) =>
    apiClient.post<{ proposal: TaskProposalDTO; created: boolean }>(`/backlog/${itemId}/proposal`, {}),
  approveProposal: (proposalId: string) =>
    apiClient.post<{ proposal: TaskProposalDTO }>(`/task-proposals/${proposalId}/approve`, {}).then((r) => r.proposal),
  rejectProposal: (proposalId: string) =>
    apiClient.post<{ proposal: TaskProposalDTO }>(`/task-proposals/${proposalId}/reject`, {}).then((r) => r.proposal),
  /** Produces an ordinary BACKLOG task — never starts it. 409 CONVERSION_IN_PROGRESS while another convert is in flight. */
  convertProposal: (proposalId: string) => apiClient.post<ConvertProposalResult>(`/task-proposals/${proposalId}/convert`, {}),
};
