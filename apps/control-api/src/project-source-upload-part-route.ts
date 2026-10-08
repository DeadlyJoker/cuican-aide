import { ApplicationError } from "@crewon/application";
import {
  parseProjectSourceUploadPartPath,
  parseProjectSourceUploadPartResponse,
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
} from "@crewon/contracts/project-source-uploads";
import type { FastifyInstance } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import { requestContext } from "./request-context.ts";

/** Raw parts use the mounted UI identity and an independent write policy, never JSON/base64. */
export function registerProjectSourceUploadPartRoute(
  app: FastifyInstance,
  dependencies: Readonly<{
    identity: ControlApiIdentityPort;
    service: PluginUiControlService;
  }>,
): void {
  const write = dependencies.service.invokeProjectSourceUploadPart?.bind(
    dependencies.service,
  );
  if (write === undefined) return;
  const authenticated =
    dependencies.service.invokeProjectSourceUploadPartAuthenticatedRequest?.bind(
      dependencies.service,
    );
  void app.register(async (scoped) => {
    scoped.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: PROJECT_SOURCE_UPLOAD_PART_BYTES },
      (_request, body, done) => done(null, body),
    );
    scoped.put<{ Body: unknown }>(
      "/api/v1/plugins/ui/mounts/:mountRef/source-uploads/:uploadId/parts/:partIndex/:rawDigest",
      { bodyLimit: PROJECT_SOURCE_UPLOAD_PART_BYTES },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        reply.header("x-content-type-options", "nosniff");
        reply.header("cross-origin-resource-policy", "same-origin");
        const command = parseProjectSourceUploadPartPath(request.raw.url);
        if (
          request.headers["content-type"] !== "application/octet-stream" ||
          request.headers["content-encoding"] !== undefined ||
          !Buffer.isBuffer(request.body) ||
          request.body.byteLength < 1
        )
          throw new ApplicationError(
            "validation",
            "project_source_upload_part_invalid",
          );
        const context = requestContext(request);
        const actor = await dependencies.identity.resolveActor(context);
        const cancelled = new AbortController();
        const abort = () => cancelled.abort();
        const closed = () => {
          if (!reply.raw.writableEnded) abort();
        };
        request.raw.once("aborted", abort);
        reply.raw.once("close", closed);
        try {
          if (request.raw.aborted || reply.raw.destroyed) abort();
          const result =
            authenticated === undefined
              ? await write(actor, command, request.body, {
                  signal: cancelled.signal,
                })
              : await authenticated(
                  context,
                  actor,
                  command,
                  request.body,
                  cancelled.signal,
                );
          try {
            return parseProjectSourceUploadPartResponse(
              result,
              command.locator,
              request.body.byteLength,
            );
          } catch (cause) {
            throw new ApplicationError(
              "internal",
              "project_source_upload_part_response_invalid",
              { cause },
            );
          }
        } finally {
          request.raw.removeListener("aborted", abort);
          reply.raw.removeListener("close", closed);
        }
      },
    );
  });
}
