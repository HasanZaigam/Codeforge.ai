import { Router } from "express";
import type { ApplicationServices } from "../../application/index.js";
import { CreateTasksFromChatSchema, SendChatMessageSchema } from "../schemas.js";
import { asyncHandler } from "../async-handler.js";
import { InvalidRequestError } from "../../application/errors.js";

/**
 * Phase 4C — project-aware Chat inside Overview (see /docs/CHAT.md, /docs/API.md "Chat"). Mounted
 * behind requireAuth; every handler delegates to ChatService, which enforces project ownership.
 * Nothing here starts a Task on its own — see POST .../chat/create-tasks, which reuses the existing
 * generate→approve→convert bulk action path, the same one Issues & Requests already uses.
 */
export function chatRouter(services: ApplicationServices): Router {
  const router = Router();
  const chat = services.chat;

  router.get(
    "/projects/:projectId/chat/messages",
    asyncHandler(async (req, res) => {
      res.json({
        messages: chat.listMessages(req.params.projectId!, req.user!.id),
        // Phase 4D.3 — a bulk mutation ("cancel all failed tasks") awaiting an explicit yes/no reply; lets
        // the UI render Confirm/Decline buttons that send the SAME "yes"/"no" text through this same
        // sendMessage endpoint — never a second mutation path.
        pendingAction: chat.getPendingAction(req.params.projectId!, req.user!.id),
      });
    }),
  );

  router.post(
    "/projects/:projectId/chat/messages",
    asyncHandler(async (req, res) => {
      const clientRequestId = (req.headers["x-codeforge-client-request-id"] as string) || "none";
      console.log(`[chat-receive] clientRequestId=${clientRequestId} projectId=${req.params.projectId}`);
      if (clientRequestId !== "none") {
        res.setHeader("x-codeforge-client-request-id", clientRequestId);
      }
      const body = SendChatMessageSchema.parse(req.body);
      const result = await chat.sendMessage(req.params.projectId!, req.user!.id, body, clientRequestId);
      res.status(201).json(result);
    }),
  );

  router.get(
    "/projects/:projectId/chat/suggestions/:bulkJobId",
    asyncHandler(async (req, res) => {
      res.json({ suggestions: chat.listSuggestions(req.params.projectId!, req.params.bulkJobId!, req.user!.id) });
    }),
  );

  router.post(
    "/projects/:projectId/chat/create-tasks",
    asyncHandler(async (req, res) => {
      const body = CreateTasksFromChatSchema.parse(req.body);
      if (body.itemIds.length === 0) throw new InvalidRequestError("Select at least one suggestion to create.");
      const result = await chat.createTasks(req.params.projectId!, body.itemIds, req.user!.id);
      res.status(200).json(result);
    }),
  );

  return router;
}
