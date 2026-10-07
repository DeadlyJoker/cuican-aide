import type { FastifyInstance } from "fastify";
import { parseExtensionEmptyQuery } from "@crewon/contracts";
import {
  MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES,
  parseGenerateProjectMediaHttpRequest,
} from "@crewon/contracts/project-media-generations";
import { parseProjectMediaGenerationRecoveryRequest } from "@crewon/contracts/project-media-generation-recovery";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { wakeOutbox, type OutboxWakeupPort } from "./outbox-wakeup.ts";
import { withProjectMediaRequestSignal } from "./project-media-request-signal.ts";
import {
  isInstalledProjectMediaGenerationRuntime,
  InstalledProjectMediaGenerationRuntime,
} from "./installed-project-media-generation-runtime.ts";

/** Explicit host opt-in. Original identity, CSRF and scoped Core admission protect both new and replayed requests. */
export function registerProjectMediaGenerationRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    owner: InstalledProjectMediaGenerationRuntime;
    outboxWakeup: OutboxWakeupPort;
  }>,
) {
  if (!isInstalledProjectMediaGenerationRuntime(input.owner))
    throw new Error("installed_project_media_generation_owner_required");
  const generate =
    InstalledProjectMediaGenerationRuntime.prototype.generate.bind(input.owner);
  const getRecovery =
    InstalledProjectMediaGenerationRuntime.prototype.getRecovery.bind(
      input.owner,
    );
  app.get<{
    Params: { projectId: string; threadId: string };
    Querystring: unknown;
  }>(
    "/api/v1/creative-projects/:projectId/threads/:threadId/media-generation-recovery",
    async (request, reply) =>
      withProjectMediaRequestSignal(request, reply, async (signal) => {
        parseExtensionEmptyQuery(request.query);
        const context = requestContext(request);
        const actor = await input.identity.resolveActor(context);
        return getRecovery(
          context,
          actor,
          parseProjectMediaGenerationRecoveryRequest({
            projectId: request.params.projectId,
            threadId: request.params.threadId,
          }),
          signal,
        );
      }),
  );
  app.post<{
    Params: { projectId: string };
    Querystring: unknown;
    Body: unknown;
  }>(
    "/api/v1/creative-projects/:projectId/media-generations",
    { bodyLimit: MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES },
    async (request, reply) =>
      withProjectMediaRequestSignal(request, reply, async (signal) => {
        parseExtensionEmptyQuery(request.query);
        const context = requestContext(request),
          actor = await input.identity.resolveActor(context);
        const command = parseGenerateProjectMediaHttpRequest({
          projectId: request.params.projectId,
          body: request.body,
          idempotencyKey: request.headers["idempotency-key"],
        });
        const result = await generate(context, actor, command, signal);
        wakeOutbox(input.outboxWakeup);
        return result;
      }),
  );
}
