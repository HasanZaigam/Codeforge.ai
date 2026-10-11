import { apiClient } from "./client.js";
import type { AiModelInfoDTO } from "./types.js";

/** GET /settings/ai-model — read-only, truthful, see src/api/routes/ai-model.ts's own doc comment. */
export const aiModelApi = {
  getInfo: () => apiClient.get<AiModelInfoDTO>("/settings/ai-model"),
};
