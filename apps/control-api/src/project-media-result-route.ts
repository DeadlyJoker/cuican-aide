import type { FastifyInstance } from "fastify";
import { ApplicationError } from "@crewon/application";
import {
  ContractValidationError,
  parseExtensionEmptyQuery,
} from "@crewon/contracts";
import {
  parseListProjectMediaResultsRequest,
  parseProjectMediaResultLocator,
} from "@crewon/contracts/project-media-results";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import {
  InstalledProjectMediaResultRuntime,
  isInstalledProjectMediaResultRuntime,
} from "./installed-project-media-result-runtime.ts";
import { requestContext } from "./request-context.ts";
import { withProjectMediaRequestSignal } from "./project-media-request-signal.ts";
const ROOT = "/api/v1/creative-projects/:projectId/media-results";
export function registerProjectMediaResultRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    owner: InstalledProjectMediaResultRuntime;
  }>,
) {
  if (!isInstalledProjectMediaResultRuntime(input.owner))
    throw new Error("installed_project_media_result_owner_required");
  app.get<{ Params: { projectId: string }; Querystring: unknown }>(
    ROOT,
    { exposeHeadRoute: false },
    async (request, reply) =>
      withProjectMediaRequestSignal(request, reply, async (signal) => {
        const context = requestContext(request),
          actor = await input.identity.resolveActor(context),
          q = query(request.query);
        if (q.limit !== undefined && !/^(?:[1-9]|1[0-6])$/u.test(q.limit))
          invalid();
        const result =
          await InstalledProjectMediaResultRuntime.prototype.listCandidates.call(
            input.owner,
            context,
            actor,
            parseListProjectMediaResultsRequest({
              projectId: request.params.projectId,
              afterCandidateId: q.afterCandidateId ?? null,
              limit: q.limit === undefined ? 16 : Number(q.limit),
            }),
            signal,
          );
        reply.header("cache-control", "no-store");
        return result;
      }),
  );
  app.post<{
    Params: { projectId: string; runId: string; resultIndex: string };
    Querystring: unknown;
    Body: unknown;
  }>(
    `${ROOT}/:runId/:resultIndex`,
    { bodyLimit: 1024 },
    async (request, reply) =>
      withProjectMediaRequestSignal(request, reply, async (signal) => {
        parseExtensionEmptyQuery(request.query);
        parseExtensionEmptyQuery(request.body ?? {});
        const context = requestContext(request),
          actor = await input.identity.resolveActor(context);
        const result =
          await InstalledProjectMediaResultRuntime.prototype.publish.call(
            input.owner,
            context,
            actor,
            locator(request.params),
            signal,
          );
        reply.header("cache-control", "no-store");
        return result;
      }),
  );
  for (const content of [false, true])
    app.get<{
      Params: { projectId: string; runId: string; resultIndex: string };
      Querystring: unknown;
    }>(
      `${ROOT}/:runId/:resultIndex${content ? "/content" : ""}`,
      { exposeHeadRoute: false },
      async (request, reply) =>
        withProjectMediaRequestSignal(request, reply, async (signal) => {
          parseExtensionEmptyQuery(request.query);
          const context = requestContext(request),
            actor = await input.identity.resolveActor(context);
          const result =
            await InstalledProjectMediaResultRuntime.prototype.read.call(
              input.owner,
              context,
              actor,
              locator(request.params),
              signal,
            );
          reply.header("cache-control", "no-store");
          if (!content) return { candidate: result.candidate };
          if (!result.candidate || !result.bytes)
            throw new ApplicationError(
              "notFound",
              "project_media_result_not_found",
            );
          return reply
            .type("image/png")
            .header("x-content-type-options", "nosniff")
            .header(
              "content-disposition",
              'inline; filename="project-result.png"',
            )
            .header("content-length", result.bytes.byteLength)
            .header("x-crewon-candidate-id", result.candidate.candidateId)
            .header("x-crewon-byte-digest", result.candidate.media.byteDigest)
            .send(Buffer.from(result.bytes));
        }),
    );
}
function locator(p: { projectId: string; runId: string; resultIndex: string }) {
  if (!/^(?:[0-9]|1[0-5])$/u.test(p.resultIndex)) invalid();
  return parseProjectMediaResultLocator({
    ...p,
    resultIndex: Number(p.resultIndex),
  });
}
function query(input: unknown) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid();
  const copy: Record<string, string> = {},
    keys = Reflect.ownKeys(input);
  if (keys.length > 2) invalid();
  for (const key of keys) {
    if (typeof key !== "string" || !["limit", "afterCandidateId"].includes(key))
      invalid();
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (
      !d?.enumerable ||
      !Object.hasOwn(d, "value") ||
      typeof d.value !== "string" ||
      d.value.length > 128
    )
      invalid();
    copy[key] = d.value;
  }
  return copy;
}
function invalid(): never {
  throw new ContractValidationError("project_media_results_contract_invalid");
}
