import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  projectAssetPublicHead,
  projectAssetPublicRevision,
  projectAssetPublicReference,
  projectAssetPublicView,
  projectAssetPublicMutation,
  projectAssetPublicPage,
  type ProjectAssetApplicationService,
  isProjectAssetApplicationService,
} from "@crewon/application";
import {
  parseProjectAssetId,
  parseProjectAssetUiActionRequest,
  parseProjectAssetUiActionResponse,
  MAX_PROJECT_ASSET_UI_INPUT_BYTES,
  type ProjectAssetUiAction,
} from "@crewon/contracts/project-assets";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
type Params = {
  projectId: string;
  assetId?: string;
  contentRevision?: string;
  referenceRevision?: string;
};
const ROOT = "/api/v1/creative-projects/:projectId/assets";

/** Opt-in authenticated metadata routes. No Run, execution grant or supplier POST is constructed. */
export function registerProjectAssetRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    assets: ProjectAssetApplicationService;
  }>,
) {
  if (!isProjectAssetApplicationService(input.assets))
    throw new Error("project_asset_service_required");
  const actor = (request: FastifyRequest) =>
    input.identity.resolveActor(requestContext(request));
  const ids = (p: Params) => ({
    projectId: parseProjectAssetId(p.projectId),
    assetId: parseProjectAssetId(p.assetId),
  });
  const parse = (action: ProjectAssetUiAction, body: unknown) =>
    parseProjectAssetUiActionRequest({ action, input: body });
  const empty = (query: unknown) => strictQuery(query, []);
  app.get<{ Params: Params; Querystring: unknown }>(
    ROOT,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        query = strictQuery(request.query, ["afterAssetId", "limit"]),
        req = parse("crewon.project-assets.v1.listAssets", {
          projectId: request.params.projectId,
          afterAssetId: query.afterAssetId ?? null,
          limit: number(query.limit, 8),
        });
      if (req.action !== "crewon.project-assets.v1.listAssets")
        throw new Error("project_asset_route_invalid");
      const page = await input.assets.listAssets(who, {
        ...req.input,
        kind: null,
      });
      return parseProjectAssetUiActionResponse(
        req,
        projectAssetPublicPage({
          items: page.assets.map(projectAssetPublicHead),
          continuation: page.nextAssetId,
          cursorOf: (item) => item.assetId,
          response: (assets, nextAssetId) => ({ assets, nextAssetId }),
        }),
      );
    },
  );
  app.get<{ Params: Params; Querystring: unknown }>(
    `${ROOT}/items/:assetId`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request);
      empty(request.query);
      const req = parse(
        "crewon.project-assets.v1.getAsset",
        ids(request.params),
      );
      if (req.action !== "crewon.project-assets.v1.getAsset")
        throw new Error("project_asset_route_invalid");
      return parseProjectAssetUiActionResponse(req, {
        view: projectAssetPublicView(
          await input.assets.getAsset(who, req.input),
        ),
      });
    },
  );
  app.get<{ Params: Params; Querystring: unknown }>(
    `${ROOT}/items/:assetId/revisions/:contentRevision`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request);
      empty(request.query);
      const req = parse("crewon.project-assets.v1.getRevision", {
        ...ids(request.params),
        contentRevision: number(request.params.contentRevision),
      });
      if (req.action !== "crewon.project-assets.v1.getRevision")
        throw new Error("project_asset_route_invalid");
      return parseProjectAssetUiActionResponse(req, {
        contentRevision: projectAssetPublicRevision(
          await input.assets.getRevision(who, req.input),
        ),
      });
    },
  );
  app.get<{ Params: Params; Querystring: unknown }>(
    `${ROOT}/items/:assetId/references/:referenceRevision`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request);
      empty(request.query);
      const req = parse("crewon.project-assets.v1.getReferenceRevision", {
        ...ids(request.params),
        referenceRevision: number(request.params.referenceRevision),
      });
      if (req.action !== "crewon.project-assets.v1.getReferenceRevision")
        throw new Error("project_asset_route_invalid");
      return parseProjectAssetUiActionResponse(req, {
        referenceRevision: projectAssetPublicReference(
          await input.assets.getReferenceRevision(who, req.input),
        ),
      });
    },
  );
  app.get<{ Params: Params; Querystring: unknown }>(
    `${ROOT}/items/:assetId/revisions`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        query = strictQuery(request.query, ["afterContentRevision", "limit"]),
        req = parse("crewon.project-assets.v1.listRevisions", {
          ...ids(request.params),
          afterContentRevision: number(query.afterContentRevision, 0),
          limit: number(query.limit, 8),
        });
      if (req.action !== "crewon.project-assets.v1.listRevisions")
        throw new Error("project_asset_route_invalid");
      const page = await input.assets.listRevisions(who, req.input);
      return parseProjectAssetUiActionResponse(
        req,
        projectAssetPublicPage({
          items: page.revisions.map(projectAssetPublicRevision),
          continuation: page.nextContentRevision,
          cursorOf: (item) => item.contentRevision,
          response: (revisions, nextContentRevision) => ({
            revisions,
            nextContentRevision,
          }),
        }),
      );
    },
  );
  app.get<{ Params: Params; Querystring: unknown }>(
    `${ROOT}/items/:assetId/references`,
    { exposeHeadRoute: false },
    async (request) => {
      const who = await actor(request),
        query = strictQuery(request.query, ["afterReferenceRevision", "limit"]),
        req = parse("crewon.project-assets.v1.listReferences", {
          ...ids(request.params),
          afterReferenceRevision: number(query.afterReferenceRevision, 0),
          limit: number(query.limit, 8),
        });
      if (req.action !== "crewon.project-assets.v1.listReferences")
        throw new Error("project_asset_route_invalid");
      const page = await input.assets.listReferences(who, req.input);
      return parseProjectAssetUiActionResponse(
        req,
        projectAssetPublicPage({
          items: page.references.map(projectAssetPublicReference),
          continuation: page.nextReferenceRevision,
          cursorOf: (item) => item.referenceRevision,
          response: (references, nextReferenceRevision) => ({
            references,
            nextReferenceRevision,
          }),
        }),
      );
    },
  );
  const mutate =
    (action: ProjectAssetUiAction, create = false) =>
    async (
      request: FastifyRequest<{
        Params: Params;
        Querystring: unknown;
        Body: unknown;
      }>,
    ) => {
      const who = await actor(request);
      empty(request.query);
      const req = parse(action, {
        projectId: request.params.projectId,
        assetId: create ? null : request.params.assetId,
        request: request.body,
        idempotencyKey: request.headers["idempotency-key"],
      });
      let result;
      switch (req.action) {
        case "crewon.project-assets.v1.saveCandidate":
          result = await input.assets.saveCandidate(who, {
            ...req.input.request,
            projectId: req.input.projectId,
            assetId: req.input.assetId,
            idempotencyKey: req.input.idempotencyKey,
          });
          break;
        case "crewon.project-assets.v1.selectRevision":
          result = await input.assets.selectRevision(who, {
            ...req.input.request,
            projectId: req.input.projectId,
            assetId: req.input.assetId,
            idempotencyKey: req.input.idempotencyKey,
          });
          break;
        case "crewon.project-assets.v1.setLocked":
          result = await input.assets.setLocked(who, {
            ...req.input.request,
            projectId: req.input.projectId,
            assetId: req.input.assetId,
            idempotencyKey: req.input.idempotencyKey,
          });
          break;
        case "crewon.project-assets.v1.saveReferenceCandidate":
          result = await input.assets.saveReferenceCandidate(who, {
            ...req.input.request,
            projectId: req.input.projectId,
            assetId: req.input.assetId,
            idempotencyKey: req.input.idempotencyKey,
          });
          break;
        case "crewon.project-assets.v1.selectReference":
          result = await input.assets.selectReference(who, {
            ...req.input.request,
            projectId: req.input.projectId,
            assetId: req.input.assetId,
            idempotencyKey: req.input.idempotencyKey,
          });
          break;
        default:
          throw new Error("project_asset_route_invalid");
      }
      return parseProjectAssetUiActionResponse(
        req,
        projectAssetPublicMutation(result),
      );
    };
  const options = { bodyLimit: MAX_PROJECT_ASSET_UI_INPUT_BYTES };
  app.post(
    `${ROOT}/candidates`,
    options,
    mutate("crewon.project-assets.v1.saveCandidate", true),
  );
  app.post(
    `${ROOT}/items/:assetId/candidates`,
    options,
    mutate("crewon.project-assets.v1.saveCandidate"),
  );
  app.put(
    `${ROOT}/items/:assetId/selection`,
    options,
    mutate("crewon.project-assets.v1.selectRevision"),
  );
  app.put(
    `${ROOT}/items/:assetId/lock`,
    options,
    mutate("crewon.project-assets.v1.setLocked"),
  );
  app.post(
    `${ROOT}/items/:assetId/reference-candidates`,
    options,
    mutate("crewon.project-assets.v1.saveReferenceCandidate"),
  );
  app.put(
    `${ROOT}/items/:assetId/reference-selection`,
    options,
    mutate("crewon.project-assets.v1.selectReference"),
  );
}
function strictQuery(
  value: unknown,
  allowed: readonly string[],
): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const result: Record<string, string> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const field =
      typeof key === "string"
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined;
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !field?.enumerable ||
      !Object.hasOwn(field, "value") ||
      typeof field.value !== "string"
    )
      invalid();
    result[key as string] = field!.value;
  }
  return result;
}
function number(value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return invalid();
  return Number(value);
}
function invalid(): never {
  return parseProjectAssetUiActionRequest(null) as never;
}
