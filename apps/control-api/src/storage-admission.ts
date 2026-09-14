import type { FastifyInstance } from "fastify";
import {
  StorageAdmissionError,
  type StorageAdmissionPort,
} from "@crewon/application";

const RECOVERY_POST_ROUTES = new Set([
  "/api/v1/runs/:runId([^:]+)::cancel",
  "/api/v1/threads/:threadId/workspace-list/:executionId([^:]+)::cancel",
  "/api/v1/threads/:threadId/workspace-list/:executionId([^:]+)::reconcile",
]);

/** Route templates come from Fastify, never from substring checks on user URLs. */
export function installStorageAdmission(
  app: FastifyInstance,
  admission: StorageAdmissionPort | undefined,
): void {
  if (admission === undefined) return;
  app.addHook("preHandler", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const route = request.routeOptions.url;
    if (
      request.method === "POST" &&
      route !== undefined &&
      RECOVERY_POST_ROUTES.has(route)
    )
      return;
    if (
      request.method === "DELETE" &&
      route === "/api/v1/threads/:threadId/goal"
    )
      return;
    if (
      request.method === "POST" &&
      route === "/api/v1/tool-approvals/:approvalId([^:]+)::decide" &&
      typeof request.body === "object" &&
      request.body !== null &&
      "decision" in request.body &&
      request.body.decision === "rejected"
    )
      return;
    try {
      await admission.assertNewWorkAllowed();
    } catch (error) {
      if (!(error instanceof StorageAdmissionError)) throw error;
      return reply
        .code(503)
        .header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)))
        .send({
          error: {
            category: "internal",
            code: error.code,
            message:
              "Storage capacity is temporarily unavailable for new work.",
            requestId: request.id,
          },
        });
    }
  });
}
