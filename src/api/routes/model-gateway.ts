import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { TokenBudgetSchema } from "../schemas.js";
import { AiProviderIdSchema, ChangeAiProviderModelSchema, ConnectAiProviderSchema, ListAiProviderModelsSchema, SetGlobalAiConfigSchema } from "../schemas.js";
import { asyncHandler } from "../async-handler.js";
import { InvalidRequestError } from "../../application/errors.js";

/**
 * Model Gateway — Settings -> AI / Models (see docs/MODEL_GATEWAY.md). Mounted behind requireAuth
 * (see app.ts) — every handler here can assume req.user is set; every operation is scoped to
 * req.user.id (the account), never a cross-account read/write. The provider's API key is write-only
 * — never echoed back in any response (see ModelGatewayService.listConnections's masked DTO).
 */
export function modelGatewayRouter(services: ApplicationServices): Router {
  const router = Router();

  router.get(
    "/settings/ai-gateway/connections",
    asyncHandler(async (req, res) => {
      res.json({ connections: services.modelGateway.listConnections(req.user!.id) });
    }),
  );

  // A real, on-demand "list models" call for THIS key — never persisted, never a hardcoded catalog.
  // Called from the Connect dialog before the user has necessarily decided to save anything, so the
  // UI can offer a dropdown instead of asking someone to type an exact model id from memory.
  router.post(
    "/settings/ai-gateway/providers/:provider/models",
    asyncHandler(async (req, res) => {
      const provider = AiProviderIdSchema.parse(req.params.provider);
      const input = ListAiProviderModelsSchema.parse(req.body);
      const result = await services.modelGateway.listAvailableModels(provider, input.apiKey);
      res.json(result);
    }),
  );

  router.post(
    "/settings/ai-gateway/connections/:provider",
    asyncHandler(async (req, res) => {
      const provider = AiProviderIdSchema.parse(req.params.provider);
      const input = ConnectAiProviderSchema.parse(req.body);
      const connection = await services.modelGateway.connectProvider(req.user!.id, provider, input.apiKey, input.model);
      res.status(200).json(connection);
    }),
  );

  // Same live "list models" call, but with the connection's STORED key — the key never leaves the server.
  router.get(
    "/settings/ai-gateway/connections/:provider/models",
    asyncHandler(async (req, res) => {
      const provider = AiProviderIdSchema.parse(req.params.provider);
      res.json(await services.modelGateway.listModelsForConnection(req.user!.id, provider));
    }),
  );

  // Change only the model of an existing connection (the stored key is reused, never re-sent).
  router.patch(
    "/settings/ai-gateway/connections/:provider",
    asyncHandler(async (req, res) => {
      const provider = AiProviderIdSchema.parse(req.params.provider);
      const input = ChangeAiProviderModelSchema.parse(req.body);
      res.json(await services.modelGateway.changeConnectionModel(req.user!.id, provider, input.model));
    }),
  );

  router.post(
    "/settings/ai-gateway/connections/:provider/test",
    asyncHandler(async (req, res) => {
      const provider = AiProviderIdSchema.parse(req.params.provider);
      const result = await services.modelGateway.testConnection(req.user!.id, provider);
      res.json(result);
    }),
  );

  router.delete(
    "/settings/ai-gateway/connections/:provider",
    asyncHandler(async (req, res) => {
      const provider = AiProviderIdSchema.parse(req.params.provider);
      services.modelGateway.disconnectProvider(req.user!.id, provider);
      res.status(204).end();
    }),
  );

  router.get(
    "/settings/ai-gateway/config",
    asyncHandler(async (req, res) => {
      res.json(services.modelGateway.getGlobalConfig(req.user!.id));
    }),
  );

  router.put(
    "/settings/ai-gateway/config",
    asyncHandler(async (req, res) => {
      const input = SetGlobalAiConfigSchema.parse(req.body);
      if (input.mode === "fixed" && !input.fixedProvider) throw new InvalidRequestError("A fixed global AI brain needs a provider.");
      res.json(services.modelGateway.setGlobalConfig(req.user!.id, input));
    }),
  );

  // Account-wide token usage this month across every project, against the optional account budget (TD-63).
  router.get(
    "/settings/token-usage",
    asyncHandler(async (req, res) => {
      res.json({ usage: services.tokenUsage.accountUsage(req.user!.id) });
    }),
  );

  router.put(
    "/settings/token-budget",
    asyncHandler(async (req, res) => {
      const input = TokenBudgetSchema.parse(req.body);
      res.json({ usage: services.tokenUsage.setAccountBudget(req.user!.id, input.monthlyTokens) });
    }),
  );

  router.get(
    "/settings/ai-gateway/usage",
    asyncHandler(async (req, res) => {
      res.json({ usage: services.modelGateway.getUsageSummary(req.user!.id) });
    }),
  );

  return router;
}
