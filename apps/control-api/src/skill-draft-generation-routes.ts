import {
  ApplicationError,
  parseSkillDraftGenerationInput,
  type ActorContext,
  type SkillDraftGenerationService,
} from "@crewon/application";
import { SkillError, skillKeys, skillText } from "@crewon/domain";
import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import type { OutboxWakeupPort } from "./control-api.ts";
import { requestContext } from "./request-context.ts";
import { errorResponse } from "./control-api-errors.ts";

export function registerSkillDraftGenerationRoutes(
  app: FastifyInstance,
  dependencies: {
    generations: SkillDraftGenerationService | null;
    identity: ControlApiIdentityPort;
    outboxWakeup: OutboxWakeupPort;
  },
): void {
  const base = "/api/v1/skills/:skillId/generations";
  function route(
    method: HTTPMethods,
    url: string,
    handle: (
      request: FastifyRequest,
      actor: ActorContext,
      generations: SkillDraftGenerationService,
    ) => Promise<unknown>,
  ) {
    app.route({
      method,
      url,
      bodyLimit: 16 * 1024,
      async handler(request, reply) {
        try {
          const actor = await dependencies.identity.resolveActor(
            requestContext(request),
          );
          if (!dependencies.generations)
            return reply.code(503).send({
              error: {
                category: "internal",
                code: "skill_generation_host_unavailable",
                message: "The Skill generation host is unavailable.",
                requestId: request.id,
              },
            });
          skillKeys({ ...(request.query as Record<string, unknown>) }, []);
          return await handle(request, actor, dependencies.generations);
        } catch (error) {
          const result = errorResponse(
            error instanceof SkillError
              ? new ApplicationError("validation", error.code)
              : error,
            request.id,
          );
          return reply.code(result.statusCode).send(result.body);
        }
      },
    });
  }
  route("POST", base, async (request, actor, generations) => {
    const input = parseSkillDraftGenerationInput(request.body);
    const result = await generations.start(
      actor,
      parameter(request, "skillId"),
      input,
    );
    void dependencies.outboxWakeup.wake().catch(() => {
      /* Existing durable queue scanning retries. */
    });
    return result;
  });
  route("GET", base, async (request, actor, generations) => ({
    generations: await generations.list(actor, parameter(request, "skillId")),
  }));
  route("GET", `${base}/:generationId`, async (request, actor, generations) =>
    generations.read(
      actor,
      parameter(request, "skillId"),
      parameter(request, "generationId"),
    ),
  );
  route(
    "POST",
    `${base}/:generationId/collect`,
    async (request, actor, generations) => {
      skillKeys(request.body, []);
      return generations.collect(
        actor,
        parameter(request, "skillId"),
        parameter(request, "generationId"),
      );
    },
  );
  route(
    "POST",
    `${base}/:generationId/apply`,
    async (request, actor, generations) => {
      skillKeys(request.body, ["expectedSkillRevision"]);
      const revision = request.body.expectedSkillRevision;
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw new ApplicationError(
          "validation",
          "skill_generation_revision_invalid",
        );
      return generations.apply(
        actor,
        parameter(request, "skillId"),
        parameter(request, "generationId"),
        revision,
      );
    },
  );
}
function parameter(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  skillText(value, 128);
  if (/[\u0000-\u001f\u007f]/u.test(value))
    throw new ApplicationError("validation", "skill_generation_id_invalid");
  return value;
}
