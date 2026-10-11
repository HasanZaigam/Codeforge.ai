import { apiClient } from "./client.js";
import type { AdjudicationImportSummaryDTO, AdjudicationMetricsDTO, BaselineDTO, LabelCountsDTO, ClarificationLabel, DuplicateSampleDTO, ItemJudgmentDTO, ItemSampleDTO, ProposalReadinessLabel, RelationshipJudgmentDTO, RelationshipJudgmentLabel, ReviewJudgmentCategory } from "./types.js";

/**
 * Phase 4B.1 bulk-backlog adjudication — see /docs/API.md "Adjudication". Every judgment call takes only `{ label, note? }`
 * (or `{ category, label, note? }`) — never an analysisId or revision; the server always binds to whatever is CURRENT.
 */
export const adjudicationApi = {
  sampleDuplicates: (projectId: string, seed: string, size: number) =>
    apiClient.get<DuplicateSampleDTO>(`/projects/${projectId}/backlog/adjudication/sample/duplicates?seed=${encodeURIComponent(seed)}&size=${size}`),
  sampleClarification: (projectId: string, seed: string, size: number) =>
    apiClient.get<ItemSampleDTO>(`/projects/${projectId}/backlog/adjudication/sample/clarification?seed=${encodeURIComponent(seed)}&size=${size}`),
  sampleProposalReady: (projectId: string, seed: string, size: number) =>
    apiClient.get<ItemSampleDTO>(`/projects/${projectId}/backlog/adjudication/sample/proposal-ready?seed=${encodeURIComponent(seed)}&size=${size}`),
  judgeRelationship: (relationshipId: string, label: RelationshipJudgmentLabel, note?: string) =>
    apiClient.post<{ judgment: RelationshipJudgmentDTO }>(`/backlog/relationships/${relationshipId}/judgments`, { label, ...(note ? { note } : {}) }).then((r) => r.judgment),
  listRelationshipJudgments: (relationshipId: string) => apiClient.get<{ judgments: RelationshipJudgmentDTO[] }>(`/backlog/relationships/${relationshipId}/judgments`).then((r) => r.judgments),
  judgeItem: (itemId: string, category: ReviewJudgmentCategory, label: ClarificationLabel | ProposalReadinessLabel, note?: string) =>
    apiClient.post<{ judgment: ItemJudgmentDTO }>(`/backlog/items/${itemId}/judgments`, { category, label, ...(note ? { note } : {}) }).then((r) => r.judgment),
  listItemJudgments: (itemId: string, category: ReviewJudgmentCategory) =>
    apiClient.get<{ judgments: ItemJudgmentDTO[] }>(`/backlog/items/${itemId}/judgments?category=${category}`).then((r) => r.judgments),
  metrics: (projectId: string) => apiClient.get<AdjudicationMetricsDTO>(`/projects/${projectId}/backlog/adjudication/metrics`),
  labelCounts: (projectId: string) => apiClient.get<LabelCountsDTO>(`/projects/${projectId}/backlog/adjudication/label-counts`),
  exportUrl: (projectId: string) => `/api/projects/${projectId}/backlog/adjudication/export`,
};

export const adjudicationBaselineApi = {
  importCsv: (projectId: string, csv: string) => apiClient.post<AdjudicationImportSummaryDTO>(`/projects/${projectId}/backlog/adjudication/import`, { csv }),
  createBaseline: (projectId: string, input: { seed: string; duplicateSize: number; clarificationSize: number; proposalReadySize: number; sourceName?: string; runId?: string }) =>
    apiClient.post<{ baseline: BaselineDTO }>(`/projects/${projectId}/backlog/adjudication/baselines`, input).then((r) => r.baseline),
  listBaselines: (projectId: string) => apiClient.get<{ baselines: BaselineDTO[] }>(`/projects/${projectId}/backlog/adjudication/baselines`).then((r) => r.baselines),
  getBaseline: (baselineId: string) => apiClient.get<{ baseline: BaselineDTO }>(`/backlog/adjudication/baselines/${baselineId}`).then((r) => r.baseline),
};
