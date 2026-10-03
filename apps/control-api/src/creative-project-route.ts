import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CreativeProjectApplicationService } from "@crewon/application";
import {
  formatCreativeProjectCursor,
  parseAppendConceptAssetRevisionRequest,
  parseAppendProjectBriefRequest,
  parseConceptAssetListQuery,
  parseConceptRevisionListQuery,
  parseCreateConceptAssetRequest,
  parseCreateCreativeProjectRequest,
  parseCreativeProjectEmptyQuery,
  parseCreativeProjectId,
  parseCreativeProjectIdempotencyKey,
  parseCreativeProjectListQuery,
  parseCreativeProjectRevision,
  parseProjectBriefListQuery,
  parseRenameCreativeProjectRequest,
  parseSetCreativeProjectStateRequest,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import {
  boundedCreativePage,
  boundedCreativeResponse,
  projectConceptAsset,
  projectConceptRevision,
  projectCreativeBrief,
  projectCreativeMutation,
  projectCreativeProject,
} from "./creative-project-projection.ts";

type ProjectParams = { projectId: string };
type AssetParams = ProjectParams & { assetId: string };
const ROOT = "/api/v1/creative-projects";

/** Explicit opt-in metadata service. These routes neither submit a Run nor call a supplier. */
export function registerCreativeProjectRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    creativeProjects: CreativeProjectApplicationService;
  },
): void {
  const projects = dependencies.creativeProjects;
  const actorOf = (request: FastifyRequest) =>
    dependencies.identity.resolveActor(requestContext(request));
  const keyOf = (request: FastifyRequest) =>
    parseCreativeProjectIdempotencyKey(request.headers["idempotency-key"]);
  const projectIdOf = (params: ProjectParams) =>
    parseCreativeProjectId(params.projectId);
  const assetIds = (params: AssetParams) => ({
    projectId: projectIdOf(params),
    assetId: parseCreativeProjectId(params.assetId),
  });

  app.get<{ Querystring: unknown }>(
    ROOT,
    { exposeHeadRoute: false },
    async (request) => {
      const actor = await actorOf(request);
      const query = parseCreativeProjectListQuery(request.query);
      const page = await projects.listProjects(actor, query);
      return boundedCreativePage({
        items: page.projects.map(projectCreativeProject),
        continuation: page.next,
        cursorOf: (item) => ({
          updatedAt: item.updatedAt,
          projectId: item.projectId,
        }),
        response: (items, next) => ({
          projects: items,
          nextCursor:
            next === null
              ? null
              : formatCreativeProjectCursor(query.state, next),
        }),
      });
    },
  );
  app.post<{ Body: unknown; Querystring: unknown }>(ROOT, async (request) => {
    const actor = await actorOf(request);
    parseCreativeProjectEmptyQuery(request.query);
    const command = {
      ...parseCreateCreativeProjectRequest(request.body),
      idempotencyKey: keyOf(request),
    };
    return projectCreativeMutation(
      await projects.createProject(actor, command),
    );
  });
  app.get<{ Params: ProjectParams; Querystring: unknown }>(
    `${ROOT}/:projectId`,
    { exposeHeadRoute: false },
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return boundedCreativeResponse({
        project: projectCreativeProject(
          await projects.getProject(actor, {
            projectId: projectIdOf(request.params),
          }),
        ),
      });
    },
  );
  app.put<{ Params: ProjectParams; Body: unknown; Querystring: unknown }>(
    `${ROOT}/:projectId/title`,
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return projectCreativeMutation(
        await projects.renameProject(actor, {
          ...parseRenameCreativeProjectRequest(request.body),
          projectId: projectIdOf(request.params),
          idempotencyKey: keyOf(request),
        }),
      );
    },
  );
  app.put<{ Params: ProjectParams; Body: unknown; Querystring: unknown }>(
    `${ROOT}/:projectId/state`,
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return projectCreativeMutation(
        await projects.setProjectState(actor, {
          ...parseSetCreativeProjectStateRequest(request.body),
          projectId: projectIdOf(request.params),
          idempotencyKey: keyOf(request),
        }),
      );
    },
  );
  app.get<{ Params: ProjectParams; Querystring: unknown }>(
    `${ROOT}/:projectId/briefs`,
    { exposeHeadRoute: false },
    async (request) => {
      const actor = await actorOf(request);
      const projectId = projectIdOf(request.params);
      const query = parseProjectBriefListQuery(request.query);
      const items = (
        await projects.listBriefs(actor, { projectId, ...query })
      ).map(projectCreativeBrief);
      return boundedCreativePage({
        items,
        continuation:
          items.length === query.limit ? items.at(-1)!.briefRevision : null,
        cursorOf: (item) => item.briefRevision,
        response: (briefs, nextAfterBriefRevision) => ({
          briefs,
          nextAfterBriefRevision,
        }),
      });
    },
  );
  app.post<{ Params: ProjectParams; Body: unknown; Querystring: unknown }>(
    `${ROOT}/:projectId/briefs`,
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return projectCreativeMutation(
        await projects.appendBrief(actor, {
          ...parseAppendProjectBriefRequest(request.body),
          projectId: projectIdOf(request.params),
          idempotencyKey: keyOf(request),
        }),
      );
    },
  );
  app.get<{
    Params: ProjectParams & { briefRevision: string };
    Querystring: unknown;
  }>(
    `${ROOT}/:projectId/briefs/:briefRevision`,
    { exposeHeadRoute: false },
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return boundedCreativeResponse({
        brief: projectCreativeBrief(
          await projects.getBrief(actor, {
            projectId: projectIdOf(request.params),
            briefRevision: pathRevision(request.params.briefRevision),
          }),
        ),
      });
    },
  );
  app.get<{ Params: ProjectParams; Querystring: unknown }>(
    `${ROOT}/:projectId/concepts`,
    { exposeHeadRoute: false },
    async (request) => {
      const actor = await actorOf(request);
      const query = parseConceptAssetListQuery(request.query);
      const items = (
        await projects.listConceptAssets(actor, {
          projectId: projectIdOf(request.params),
          ...query,
        })
      ).map(projectConceptAsset);
      return boundedCreativePage({
        items,
        continuation:
          items.length === query.limit ? items.at(-1)!.assetId : null,
        cursorOf: (item) => item.assetId,
        response: (assets, nextAfterAssetId) => ({ assets, nextAfterAssetId }),
      });
    },
  );
  app.post<{ Params: ProjectParams; Body: unknown; Querystring: unknown }>(
    `${ROOT}/:projectId/concepts`,
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return projectCreativeMutation(
        await projects.createConcept(actor, {
          ...parseCreateConceptAssetRequest(request.body),
          projectId: projectIdOf(request.params),
          idempotencyKey: keyOf(request),
        }),
      );
    },
  );
  app.get<{ Params: AssetParams; Querystring: unknown }>(
    `${ROOT}/:projectId/concepts/:assetId`,
    { exposeHeadRoute: false },
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return boundedCreativeResponse({
        asset: projectConceptAsset(
          await projects.getConceptAsset(actor, assetIds(request.params)),
        ),
      });
    },
  );
  app.get<{ Params: AssetParams; Querystring: unknown }>(
    `${ROOT}/:projectId/concepts/:assetId/revisions`,
    { exposeHeadRoute: false },
    async (request) => {
      const actor = await actorOf(request);
      const query = parseConceptRevisionListQuery(request.query);
      const items = (
        await projects.listConceptRevisions(actor, {
          ...assetIds(request.params),
          ...query,
        })
      ).map(projectConceptRevision);
      return boundedCreativePage({
        items,
        continuation:
          items.length === query.limit ? items.at(-1)!.assetRevision : null,
        cursorOf: (item) => item.assetRevision,
        response: (revisions, nextAfterAssetRevision) => ({
          revisions,
          nextAfterAssetRevision,
        }),
      });
    },
  );
  app.post<{ Params: AssetParams; Body: unknown; Querystring: unknown }>(
    `${ROOT}/:projectId/concepts/:assetId/revisions`,
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return projectCreativeMutation(
        await projects.appendConceptRevision(actor, {
          ...parseAppendConceptAssetRevisionRequest(request.body),
          ...assetIds(request.params),
          idempotencyKey: keyOf(request),
        }),
      );
    },
  );
  app.get<{
    Params: AssetParams & { assetRevision: string };
    Querystring: unknown;
  }>(
    `${ROOT}/:projectId/concepts/:assetId/revisions/:assetRevision`,
    { exposeHeadRoute: false },
    async (request) => {
      const actor = await actorOf(request);
      parseCreativeProjectEmptyQuery(request.query);
      return boundedCreativeResponse({
        assetRevision: projectConceptRevision(
          await projects.getConceptRevision(actor, {
            ...assetIds(request.params),
            assetRevision: pathRevision(request.params.assetRevision),
          }),
        ),
      });
    },
  );
}

function pathRevision(value: string): number {
  // Reuse the contract's strict numeric parser after rejecting non-canonical URL numbers.
  return parseCreativeProjectRevision(
    /^[1-9][0-9]*$/u.test(value) ? Number(value) : NaN,
  );
}
