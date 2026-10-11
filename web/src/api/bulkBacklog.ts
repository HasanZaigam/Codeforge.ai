import { apiClient } from "./client.js";
import type { BacklogGroupsDTO, BacklogImportDTO, BulkActionKey, BulkActionResultDTO, BulkReviewDTO, BulkViewDTO, ImportPreviewDTO, ReviewFilterKey } from "./types.js";

/**
 * Phase 4B bulk backlog — see /docs/API.md "Bulk backlog". Import and preview never call a model; `start` only ENQUEUES the existing
 * per-item analysis jobs (202). No call here can start a task.
 */
export const bulkBacklogApi = {
  preview: (projectId: string, csv: string, sourceName: string) =>
    apiClient.post<{ preview: ImportPreviewDTO }>(`/projects/${projectId}/backlog/imports/preview`, { csv, sourceName }).then((r) => r.preview),
  confirmImport: (projectId: string, csv: string, sourceName: string) =>
    apiClient.post<{ import: BacklogImportDTO }>(`/projects/${projectId}/backlog/imports`, { csv, sourceName }).then((r) => r.import),
  listImports: (projectId: string) => apiClient.get<{ imports: BacklogImportDTO[] }>(`/projects/${projectId}/backlog/imports`).then((r) => r.imports),
  startAnalysis: (projectId: string, sel: { importId: string } | { itemIds: string[] }) =>
    apiClient.post<{ bulk: BulkViewDTO; created: boolean }>(`/projects/${projectId}/backlog/bulk-analysis`, sel),
  listBulk: (projectId: string) => apiClient.get<{ bulkAnalyses: BulkViewDTO[] }>(`/projects/${projectId}/backlog/bulk-analysis`).then((r) => r.bulkAnalyses),
  cancelBulk: (bulkId: string) => apiClient.post<{ bulk: BulkViewDTO }>(`/backlog/bulk-analysis/${bulkId}/cancel`, {}).then((r) => r.bulk),
  review: (projectId: string, filter: ReviewFilterKey) => apiClient.get<BulkReviewDTO>(`/projects/${projectId}/backlog/review?filter=${filter}`),
  groups: (projectId: string) => apiClient.get<BacklogGroupsDTO>(`/projects/${projectId}/backlog/groups`),
  reviewRelationship: (relationshipId: string, decision: "confirm" | "dismiss") =>
    apiClient.post<unknown>(`/backlog/relationships/${relationshipId}/review`, { decision }),
  action: (projectId: string, action: BulkActionKey, itemIds: string[]) => apiClient.post<BulkActionResultDTO>(`/projects/${projectId}/backlog/actions`, { action, itemIds }),
};
