import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProjectTextApplicationService } from "@crewon/application";
import {
  parseGetProjectTextArtifactResponse,
  parseGetProjectTextRevisionResponse,
  parseProjectTextArtifactListQuery,
  parseProjectTextArtifactListResponse,
  parseProjectTextContentRevision,
  parseProjectTextEmptyQuery,
  parseProjectTextId,
  parseProjectTextIdempotencyKey,
  parseProjectTextMutationResponse,
  parseProjectTextRevisionListQuery,
  parseProjectTextRevisionListResponse,
  parseSaveProjectOutlineCandidateRequest,
  parseSaveProjectScriptCandidateRequest,
  parseSelectProjectTextRevisionRequest,
  parseSetProjectTextArtifactLockedRequest,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import {
  boundedProjectTextPage,
  projectTextArtifact,
  projectTextArtifactView,
  projectTextMutation,
  projectTextRevision,
} from "./project-text-projection.ts";
type Project = { projectId: string };
type Artifact = Project & { artifactId: string };
const ROOT = "/api/v1/creative-projects/:projectId/text-artifacts";
/** Explicit composition opt-in. Metadata routes cannot dispatch a Run or supplier operation. */
export function registerProjectTextRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    projectTexts: ProjectTextApplicationService;
  }>,
): void {
  const service = input.projectTexts;
  const actor = (request: FastifyRequest) =>
    input.identity.resolveActor(requestContext(request));
  const key = (request: FastifyRequest) =>
    parseProjectTextIdempotencyKey(request.headers["idempotency-key"]);
  const project = (params: Project) => parseProjectTextId(params.projectId);
  const artifact = (params: Artifact) => ({
    projectId: project(params),
    artifactId: parseProjectTextId(params.artifactId),
  });
  app.get<{ Params: Project; Querystring: unknown }>(
    ROOT,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        projectId = project(request.params),
        query = parseProjectTextArtifactListQuery(request.query),
        page = await service.listArtifacts(who, { projectId, ...query });
      const result = boundedProjectTextPage({
        items: page.artifacts.map(projectTextArtifact),
        continuation: page.nextArtifactId,
        cursorOf: (item) => item.artifactId,
        response: (artifacts, nextArtifactId) => ({
          artifacts,
          nextArtifactId,
        }),
      });
      return parseProjectTextArtifactListResponse(result, {
        projectId,
        ...query,
      });
    },
  );
  app.get<{ Params: Project; Querystring: unknown }>(
    `${ROOT}/outline`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        projectId = project(request.params);
      parseProjectTextEmptyQuery(request.query);
      return parseGetProjectTextArtifactResponse(
        {
          view: projectTextArtifactView(
            await service.getOutline(who, { projectId }),
          ),
        },
        { projectId, kind: "outline", episodeId: null },
      );
    },
  );
  app.get<{ Params: Project & { episodeId: string }; Querystring: unknown }>(
    `${ROOT}/scripts/:episodeId`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        projectId = project(request.params),
        episodeId = parseProjectTextId(request.params.episodeId);
      parseProjectTextEmptyQuery(request.query);
      return parseGetProjectTextArtifactResponse(
        {
          view: projectTextArtifactView(
            await service.getScript(who, { projectId, episodeId }),
          ),
        },
        { projectId, kind: "script", episodeId },
      );
    },
  );
  app.post<{ Params: Project; Querystring: unknown; Body: unknown }>(
    `${ROOT}/outline/candidates`,
    async (request) => {
      const who = await actor(request),
        projectId = project(request.params);
      parseProjectTextEmptyQuery(request.query);
      const body = parseSaveProjectOutlineCandidateRequest(request.body);
      return parseProjectTextMutationResponse(
        projectTextMutation(
          await service.saveOutlineCandidate(who, {
            projectId,
            ...body,
            idempotencyKey: key(request),
          }),
        ),
        { kind: "save-outline", projectId, request: body },
      );
    },
  );
  app.post<{
    Params: Project & { episodeId: string };
    Querystring: unknown;
    Body: unknown;
  }>(`${ROOT}/scripts/:episodeId/candidates`, async (request) => {
    const who = await actor(request),
      projectId = project(request.params),
      episodeId = parseProjectTextId(request.params.episodeId);
    parseProjectTextEmptyQuery(request.query);
    const body = parseSaveProjectScriptCandidateRequest(request.body);
    return parseProjectTextMutationResponse(
      projectTextMutation(
        await service.saveScriptCandidate(who, {
          projectId,
          episodeId,
          ...body,
          idempotencyKey: key(request),
        }),
      ),
      { kind: "save-script", projectId, episodeId, request: body },
    );
  });
  app.get<{ Params: Artifact; Querystring: unknown }>(
    `${ROOT}/items/:artifactId`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        ids = artifact(request.params);
      parseProjectTextEmptyQuery(request.query);
      return parseGetProjectTextArtifactResponse(
        { view: projectTextArtifactView(await service.getArtifact(who, ids)) },
        ids,
      );
    },
  );
  app.get<{ Params: Artifact; Querystring: unknown }>(
    `${ROOT}/items/:artifactId/revisions`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        ids = artifact(request.params),
        query = parseProjectTextRevisionListQuery(request.query),
        page = await service.listRevisions(who, { ...ids, ...query });
      const result = boundedProjectTextPage({
        items: page.revisions.map(projectTextRevision),
        continuation: page.nextContentRevision,
        cursorOf: (item) => item.contentRevision,
        response: (revisions, nextContentRevision) => ({
          revisions,
          nextContentRevision,
        }),
      });
      return parseProjectTextRevisionListResponse(result, { ...ids, ...query });
    },
  );
  app.get<{
    Params: Artifact & { contentRevision: string };
    Querystring: unknown;
  }>(
    `${ROOT}/items/:artifactId/revisions/:contentRevision`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        ids = {
          ...artifact(request.params),
          contentRevision: parseProjectTextContentRevision(
            request.params.contentRevision,
          ),
        };
      parseProjectTextEmptyQuery(request.query);
      return parseGetProjectTextRevisionResponse(
        {
          contentRevision: projectTextRevision(
            await service.getRevision(who, ids),
          ),
        },
        ids,
      );
    },
  );
  app.put<{ Params: Artifact; Querystring: unknown; Body: unknown }>(
    `${ROOT}/items/:artifactId/selection`,
    async (request) => {
      const who = await actor(request),
        ids = artifact(request.params);
      parseProjectTextEmptyQuery(request.query);
      const body = parseSelectProjectTextRevisionRequest(request.body);
      return parseProjectTextMutationResponse(
        projectTextMutation(
          await service.selectRevision(who, {
            ...ids,
            ...body,
            idempotencyKey: key(request),
          }),
        ),
        { kind: "select-revision", ...ids, request: body },
      );
    },
  );
  app.put<{ Params: Artifact; Querystring: unknown; Body: unknown }>(
    `${ROOT}/items/:artifactId/lock`,
    async (request) => {
      const who = await actor(request),
        ids = artifact(request.params);
      parseProjectTextEmptyQuery(request.query);
      const body = parseSetProjectTextArtifactLockedRequest(request.body);
      return parseProjectTextMutationResponse(
        projectTextMutation(
          await service.setLocked(who, {
            ...ids,
            ...body,
            idempotencyKey: key(request),
          }),
        ),
        { kind: "set-lock", ...ids, request: body },
      );
    },
  );
}
