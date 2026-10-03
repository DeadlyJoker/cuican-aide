import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ApplicationError,
  type ExtensionReadApplicationService,
  type ProjectConceptSelectionApplicationService,
} from "@crewon/application";
import {
  MAX_PROJECT_GENERATION_SELECTION_BYTES,
  parseConceptSelectionLocator,
  parseCreativeProjectEmptyQuery,
  parseCreativeProjectIdempotencyKey,
  parseSelectConceptImageRequest,
} from "@crewon/contracts";
import { extensionCanonicalJson } from "@crewon/domain";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import {
  withInstalledPluginHttpRequest,
  captureInstalledPluginHttpReadCommitAuthority,
} from "./installed-plugin-request-owner.ts";
import { requestContext } from "./request-context.ts";
import {
  projectConceptImageSelection,
  projectConceptSelection,
} from "./project-generation-selection-projection.ts";

type Params = { projectId: string; assetId: string };
const route =
  "/api/v1/creative-projects/:projectId/concepts/:assetId/selection";

/** Both sources use the real original actor; HTTP never fabricates an installed UI invocation. */
export function registerProjectGenerationSelectionRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    identity: ControlApiIdentityPort;
    selections: ProjectConceptSelectionApplicationService;
    extensionReads: ExtensionReadApplicationService;
  }>,
): void {
  const resolveActor = dependencies.identity.resolveActor.bind(
    dependencies.identity,
  );
  const readAuthority = captureInstalledPluginHttpReadCommitAuthority(
    dependencies.extensionReads,
  );
  const run = async (
    request: FastifyRequest<{
      Params: Params;
      Querystring: unknown;
      Body: unknown;
    }>,
    reply: FastifyReply,
    mutation: boolean,
  ) => {
    const context = requestContext(request);
    const actor = await resolveActor(context);
    parseCreativeProjectEmptyQuery(request.query);
    const locator = parseConceptSelectionLocator({
      projectId: request.params.projectId,
      assetId: request.params.assetId,
    });
    let active = true;
    const abort = () => {
      active = false;
    };
    const closed = () => {
      if (!reply.raw.writableEnded) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", closed);
    const assertActive = () => {
      if (!active || request.raw.aborted || reply.raw.destroyed)
        throw new ApplicationError(
          "authorization",
          "project_generation_selection_request_unavailable",
        );
      readAuthority?.assertActive();
    };
    const assertCurrent = async () => {
      assertActive();
      const current = await resolveActor(context);
      await readAuthority?.assertCurrent();
      assertActive();
      if (extensionCanonicalJson(current) !== extensionCanonicalJson(actor)) {
        active = false;
        throw new ApplicationError(
          "authorization",
          "project_generation_selection_request_unavailable",
        );
      }
    };
    try {
      return await withInstalledPluginHttpRequest(
        dependencies.extensionReads,
        request,
        reply,
        actor,
        async () => {
          if (!mutation)
            return projectConceptSelection(
              await dependencies.selections.getConceptSelection(
                actor,
                locator,
                { authority: { assertCurrent, assertActive } },
              ),
            );
          const body = parseSelectConceptImageRequest(request.body);
          if (
            body.reference.projectId !== locator.projectId ||
            body.reference.assetId !== locator.assetId
          )
            throw new ApplicationError(
              "validation",
              "project_generation_selection_locator_mismatch",
            );
          return projectConceptImageSelection(
            await dependencies.selections.selectConceptImage(
              actor,
              {
                ...body,
                idempotencyKey: parseCreativeProjectIdempotencyKey(
                  request.headers["idempotency-key"],
                ),
              },
              {
                authority: {
                  assertCurrent,
                  assertTransactionCurrent: assertCurrent,
                  assertActive,
                },
                source: { kind: "authenticated-project-command" },
              },
            ),
          );
        },
      );
    } finally {
      active = false;
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", closed);
    }
  };
  app.get<{ Params: Params; Querystring: unknown; Body: unknown }>(
    route,
    { exposeHeadRoute: false },
    (request, reply) => run(request, reply, false),
  );
  app.put<{ Params: Params; Querystring: unknown; Body: unknown }>(
    route,
    { bodyLimit: MAX_PROJECT_GENERATION_SELECTION_BYTES },
    (request, reply) => run(request, reply, true),
  );
}
