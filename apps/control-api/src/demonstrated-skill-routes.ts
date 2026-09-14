import {
  ApplicationError,
  type ActorContext,
  type DemonstratedSkillService,
  type SkillEvidenceUpload,
  type SkillRecordingStore,
} from "@crewon/application";
import {
  parseSkillInvocationSpec,
  parseSkillMethod,
  parseSkillVersionRef,
  SkillError,
  skillKeys,
  skillObject,
  skillText,
} from "@crewon/domain";
import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import { errorResponse } from "./control-api-errors.ts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import type { OutboxWakeupPort } from "./control-api.ts";
import { requestContext } from "./request-context.ts";

export function registerDemonstratedSkillRoutes(
  app: FastifyInstance,
  dependencies: {
    skills: DemonstratedSkillService | null;
    identity: ControlApiIdentityPort;
    outboxWakeup: OutboxWakeupPort;
    recordings?: SkillRecordingStore | null;
  },
): void {
  function register(
    method: HTTPMethods,
    url: string,
    handle: (
      request: FastifyRequest,
      actor: ActorContext,
      skills: DemonstratedSkillService,
    ) => Promise<unknown>,
    bodyLimit = 64 * 1024,
  ) {
    app.route({
      method,
      url,
      bodyLimit,
      async handler(request, reply) {
        try {
          const actor = await dependencies.identity.resolveActor(
            requestContext(request),
          );
          if (dependencies.skills === null)
            return reply.code(503).send({
              error: {
                category: "internal",
                code: "skill_host_unavailable",
                message: "The Skill host is unavailable.",
                requestId: request.id,
              },
            });
          if (method !== "GET") exact(queryObject(request.query), []);
          return await handle(request, actor, dependencies.skills);
        } catch (error) {
          const mapped = errorResponse(
            error instanceof SkillError
              ? new ApplicationError("validation", error.code)
              : error,
            request.id,
          );
          return reply
            .code(
              error instanceof ApplicationError &&
                error.code === "skill_recording_store_unavailable"
                ? 503
                : mapped.statusCode,
            )
            .send(mapped.body);
        }
      },
    });
  }
  register(
    "GET",
    "/api/v1/runs/:runId/skill-invocation",
    async (request, actor, skills) => {
      exact(queryObject(request.query), []);
      const result = await skills.ensureRunSkillAllowed(
        actor,
        param(request, "runId"),
      );
      if (result === null) return null;
      return {
        threadId: result.threadId,
        skillVersionRef: result.invocation.skill,
        parameters: result.invocation.parameters,
      };
    },
  );
  register(
    "POST",
    "/api/v1/skills",
    async (request, actor, skills) => {
      skillKeys(request.body, ["recording", "evidence"]);
      const body = request.body;
      if (!skillObject(body.recording)) throw invalid();
      // Recording parser owns content/provenance validation; this endpoint bounds transport size.
      return skills.importRecording(
        actor,
        body.recording,
        uploads(body.evidence),
      );
    },
    3 * 1024 * 1024 + 64 * 1024,
  );
  register("GET", "/api/v1/skills", async (request, actor, skills) => {
    const query = queryObject(request.query);
    skillKeys(query, ["after", "limit"]);
    const { after, limit } = query;
    if (
      limit !== undefined &&
      (typeof limit !== "string" ||
        !/^[1-9][0-9]{0,2}$/u.test(limit) ||
        Number(limit) > 100)
    )
      throw invalid();
    return {
      skills: await skills.list(actor, {
        after: after === undefined ? null : identifier(after),
        limit: limit === undefined ? 50 : Number(limit),
      }),
    };
  });
  register("GET", "/api/v1/skills/:id", async (request, actor, skills) => {
    exact(queryObject(request.query), []);
    return skills.detail(actor, param(request, "id"));
  });
  register(
    "GET",
    "/api/v1/skills/:id/recording",
    async (request, actor, skills) => {
      exact(queryObject(request.query), []);
      const skill = await skills.get(actor, param(request, "id"));
      if (!dependencies.recordings)
        throw new ApplicationError(
          "internal",
          "skill_recording_store_unavailable",
        );
      const recording = await dependencies.recordings.readImportedRecording(
        scope(actor),
        skill.source,
      );
      if (recording === null)
        throw new ApplicationError("notFound", "skill_recording_not_found");
      if (Buffer.byteLength(JSON.stringify(recording)) > 2 * 1024 * 1024)
        throw new ApplicationError("internal", "skill_recording_invalid");
      return { recording };
    },
  );
  register(
    "GET",
    "/api/v1/skills/:id/evidence/:evidenceId",
    async (request, actor, skills) => {
      exact(queryObject(request.query), []);
      const evidenceId = param(request, "evidenceId");
      const skill = await skills.get(actor, param(request, "id"));
      if (!dependencies.recordings)
        throw new ApplicationError(
          "internal",
          "skill_recording_store_unavailable",
        );
      const evidence = await dependencies.recordings.readRecordingEvidence(
        scope(actor),
        skill.source,
        evidenceId,
      );
      if (evidence === null)
        throw new ApplicationError("notFound", "skill_evidence_not_found");
      uploads([evidence]);
      return { evidence };
    },
  );
  register("PATCH", "/api/v1/skills/:id", async (request, actor, skills) => {
    const body = exact(request.body, ["expectedRevision", "method"]);
    return skills.edit(
      actor,
      param(request, "id"),
      revision(body.expectedRevision),
      parseSkillMethod(body.method),
    );
  });
  register(
    "POST",
    "/api/v1/skills/:id/versions",
    async (request, actor, skills) => {
      const body = exact(request.body, ["expectedRevision"]);
      return skills.seal(
        actor,
        param(request, "id"),
        revision(body.expectedRevision),
      );
    },
  );
  register(
    "GET",
    "/api/v1/skills/:id/versions/:versionId",
    async (request, actor, skills) => {
      const query = exact(queryObject(request.query), ["contentDigest"]);
      const version = await skills.resolveVersion(
        actor,
        parseSkillVersionRef({
          skillId: param(request, "id"),
          versionId: param(request, "versionId"),
          contentDigest: query.contentDigest,
        }),
      );
      return { version, markdown: version.markdown };
    },
  );
  register(
    "POST",
    "/api/v1/skills/:id/executions",
    async (request, actor, skills) => {
      const body = exact(request.body, [
        "executionId",
        "threadId",
        "expectedThreadRevision",
        "agentVersionId",
        "purpose",
        "invocation",
      ]);
      if (body.purpose !== "trial" && body.purpose !== "execute")
        throw invalid();
      const result = await skills.startExecution(actor, param(request, "id"), {
        executionId: identifier(body.executionId),
        threadId: identifier(body.threadId, 256),
        expectedThreadRevision: revision(body.expectedThreadRevision),
        agentVersionId:
          body.agentVersionId === null
            ? null
            : identifier(body.agentVersionId, 512),
        purpose: body.purpose,
        invocation: parseSkillInvocationSpec(body.invocation),
      });
      void dependencies.outboxWakeup.wake().catch(() => {
        /* Durable scanning retries wake-up. */
      });
      return result;
    },
  );
  register(
    "POST",
    "/api/v1/skills/:id/executions/:executionId/review",
    async (request, actor, skills) => {
      const body = exact(request.body, ["criteria", "coverage", "resultNote"]);
      const criteria = textList(body.criteria, 12, 512);
      const coverage = textList(body.coverage, 3, 32);
      if (
        new Set(coverage).size !== coverage.length ||
        coverage.some(
          (value) =>
            !["new-date", "new-input", "handled-exception"].includes(value),
        )
      )
        throw invalid();
      skillText(body.resultNote, 2048);
      return skills.reviewTrial(
        actor,
        param(request, "id"),
        param(request, "executionId"),
        {
          criteria,
          coverage: coverage as (
            | "new-date"
            | "new-input"
            | "handled-exception"
          )[],
          resultNote: body.resultNote,
        },
      );
    },
  );
  register(
    "POST",
    "/api/v1/skills/:id/activate",
    async (request, actor, skills) => {
      const body = exact(request.body, ["expectedRevision", "version"]);
      return skills.activate(
        actor,
        param(request, "id"),
        revision(body.expectedRevision),
        parseSkillVersionRef(body.version),
      );
    },
  );
  register(
    "POST",
    "/api/v1/skills/:id/disable",
    async (request, actor, skills) => {
      const body = exact(request.body, ["expectedRevision", "disabled"]);
      if (typeof body.disabled !== "boolean") throw invalid();
      return skills.setDisabled(
        actor,
        param(request, "id"),
        revision(body.expectedRevision),
        body.disabled,
      );
    },
  );
}

function invalid() {
  return new ApplicationError("validation", "skill_request_invalid");
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  skillKeys(value, keys);
  if (keys.some((key) => !Object.hasOwn(value, key))) throw invalid();
  return value;
}
function identifier(value: unknown, max = 128): string {
  skillText(value, max);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  return value;
}
function param(request: FastifyRequest, name: string): string {
  return identifier(queryObject(request.params)[name]);
}
// Fastify's query parser uses its own safe prototype; copy only its own fields.
function queryObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid();
  return { ...value };
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw invalid();
  return value;
}
function textList(value: unknown, limit: number, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit)
    throw invalid();
  return value.map((item) => {
    skillText(item, max);
    return item;
  });
}
function uploads(value: unknown): readonly SkillEvidenceUpload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw invalid();
  const seen = new Set<string>();
  return value.map((item) => {
    const evidence = exact(item, ["evidenceId", "mediaType", "dataBase64"]);
    const evidenceId = identifier(evidence.evidenceId);
    if (seen.has(evidenceId)) throw invalid();
    seen.add(evidenceId);
    if (
      evidence.mediaType !== "image/png" &&
      evidence.mediaType !== "image/svg+xml"
    )
      throw invalid();
    skillText(evidence.dataBase64, 21848);
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        evidence.dataBase64,
      )
    )
      throw invalid();
    if (Buffer.from(evidence.dataBase64, "base64").byteLength > 16 * 1024)
      throw invalid();
    return {
      evidenceId,
      mediaType: evidence.mediaType,
      dataBase64: evidence.dataBase64,
    };
  });
}
function scope(actor: ActorContext) {
  return {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    ownerActorId: actor.actorId,
  };
}
