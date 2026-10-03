import {
  parseAppendConceptAssetRevisionRequest,
  parseAppendProjectBriefRequest,
  parseConceptAssetListQuery,
  parseConceptAssetListResponse,
  parseConceptRevisionListQuery,
  parseConceptRevisionListResponse,
  parseCreateConceptAssetRequest,
  parseCreateCreativeProjectRequest,
  parseCreativeProjectId,
  parseCreativeProjectIdempotencyKey,
  parseCreativeProjectListQuery,
  parseCreativeProjectListResponse,
  parseCreativeProjectMutationResponse,
  parseCreativeProjectRevision,
  parseGetConceptAssetResponse,
  parseGetConceptRevisionResponse,
  parseGetCreativeProjectResponse,
  parseGetProjectBriefResponse,
  parseProjectBriefListQuery,
  parseProjectBriefListResponse,
  parseRenameCreativeProjectRequest,
  parseSetCreativeProjectStateRequest,
  type AppendConceptAssetRevisionRequest,
  type AppendProjectBriefRequest,
  type ConceptAssetListResponse,
  type ConceptRevisionListResponse,
  type CreateConceptAssetRequest,
  type CreateCreativeProjectRequest,
  type CreativeProjectBriefMutationResponse,
  type CreativeProjectConceptMutationResponse,
  type CreativeProjectListResponse,
  type CreativeProjectListState,
  type CreativeProjectMetadataMutationResponse,
  type GetConceptAssetResponse,
  type GetConceptRevisionResponse,
  type GetCreativeProjectResponse,
  type GetProjectBriefResponse,
  type ProjectBriefListResponse,
  type RenameCreativeProjectRequest,
  type SetCreativeProjectStateRequest,
} from "./creative-project-control-contract.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

/** A requirement identifies a protocol; only the host can grant or activate it. */
export const CREWON_CREATIVE_PROJECTS_SERVICE = "crewon.creative-projects";
export const CREWON_CREATIVE_PROJECTS_API_VERSION = "1";
export const CREATIVE_PROJECT_UI_ACTIONS = Object.freeze([
  "crewon.creative-projects.v1.listProjects",
  "crewon.creative-projects.v1.getProject",
  "crewon.creative-projects.v1.createProject",
  "crewon.creative-projects.v1.renameProject",
  "crewon.creative-projects.v1.setProjectState",
  "crewon.creative-projects.v1.appendBrief",
  "crewon.creative-projects.v1.getBrief",
  "crewon.creative-projects.v1.listBriefs",
  "crewon.creative-projects.v1.createConcept",
  "crewon.creative-projects.v1.getConceptAsset",
  "crewon.creative-projects.v1.listConceptAssets",
  "crewon.creative-projects.v1.appendConceptRevision",
  "crewon.creative-projects.v1.getConceptRevision",
  "crewon.creative-projects.v1.listConceptRevisions",
] as const);
export type CreativeProjectUiAction =
  (typeof CREATIVE_PROJECT_UI_ACTIONS)[number];
export type CreativeProjectUiListQuery = Readonly<{
  state?: CreativeProjectListState;
  cursor?: string | null;
  limit?: number;
}>;
export type ProjectBriefUiListQuery = Readonly<{
  afterBriefRevision?: number;
  limit?: number;
}>;
export type ConceptAssetUiListQuery = Readonly<{
  afterAssetId?: string | null;
  limit?: number;
}>;
export type ConceptRevisionUiListQuery = Readonly<{
  afterAssetRevision?: number;
  limit?: number;
}>;
type ProjectInput = Readonly<{ projectId: string }>;
type AssetInput = ProjectInput & Readonly<{ assetId: string }>;
type MutationInput<Request> = Readonly<{
  request: Request;
  idempotencyKey: string;
}>;
export type CreativeProjectUiInputMap = {
  "crewon.creative-projects.v1.listProjects": Readonly<{
    query: CreativeProjectUiListQuery;
  }>;
  "crewon.creative-projects.v1.getProject": ProjectInput;
  "crewon.creative-projects.v1.createProject": MutationInput<CreateCreativeProjectRequest>;
  "crewon.creative-projects.v1.renameProject": ProjectInput &
    MutationInput<RenameCreativeProjectRequest>;
  "crewon.creative-projects.v1.setProjectState": ProjectInput &
    MutationInput<SetCreativeProjectStateRequest>;
  "crewon.creative-projects.v1.appendBrief": ProjectInput &
    MutationInput<AppendProjectBriefRequest>;
  "crewon.creative-projects.v1.getBrief": ProjectInput &
    Readonly<{ briefRevision: number }>;
  "crewon.creative-projects.v1.listBriefs": ProjectInput &
    Readonly<{ query: ProjectBriefUiListQuery }>;
  "crewon.creative-projects.v1.createConcept": ProjectInput &
    MutationInput<CreateConceptAssetRequest>;
  "crewon.creative-projects.v1.getConceptAsset": AssetInput;
  "crewon.creative-projects.v1.listConceptAssets": ProjectInput &
    Readonly<{ query: ConceptAssetUiListQuery }>;
  "crewon.creative-projects.v1.appendConceptRevision": AssetInput &
    MutationInput<AppendConceptAssetRevisionRequest>;
  "crewon.creative-projects.v1.getConceptRevision": AssetInput &
    Readonly<{ assetRevision: number }>;
  "crewon.creative-projects.v1.listConceptRevisions": AssetInput &
    Readonly<{ query: ConceptRevisionUiListQuery }>;
};
export type CreativeProjectUiResponseMap = {
  "crewon.creative-projects.v1.listProjects": CreativeProjectListResponse;
  "crewon.creative-projects.v1.getProject": GetCreativeProjectResponse;
  "crewon.creative-projects.v1.createProject": CreativeProjectBriefMutationResponse;
  "crewon.creative-projects.v1.renameProject": CreativeProjectMetadataMutationResponse;
  "crewon.creative-projects.v1.setProjectState": CreativeProjectMetadataMutationResponse;
  "crewon.creative-projects.v1.appendBrief": CreativeProjectBriefMutationResponse;
  "crewon.creative-projects.v1.getBrief": GetProjectBriefResponse;
  "crewon.creative-projects.v1.listBriefs": ProjectBriefListResponse;
  "crewon.creative-projects.v1.createConcept": CreativeProjectConceptMutationResponse;
  "crewon.creative-projects.v1.getConceptAsset": GetConceptAssetResponse;
  "crewon.creative-projects.v1.listConceptAssets": ConceptAssetListResponse;
  "crewon.creative-projects.v1.appendConceptRevision": CreativeProjectConceptMutationResponse;
  "crewon.creative-projects.v1.getConceptRevision": GetConceptRevisionResponse;
  "crewon.creative-projects.v1.listConceptRevisions": ConceptRevisionListResponse;
};
export type CreativeProjectUiActionRequestFor<
  Action extends CreativeProjectUiAction,
> = Readonly<{
  action: Action;
  input: CreativeProjectUiInputMap[Action];
}>;
export type CreativeProjectUiActionRequest = {
  [Action in CreativeProjectUiAction]: CreativeProjectUiActionRequestFor<Action>;
}[CreativeProjectUiAction];
export type CreativeProjectUiActionResponse =
  CreativeProjectUiResponseMap[CreativeProjectUiAction];

function numeric(input: unknown, minimum: number): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum
  )
    pluginUiFailure("creative_project_ui_action_invalid");
  return input;
}
/** JSON queries use numeric values; HTTP query validation remains authoritative. */
function rawQuery(
  input: unknown,
  fields: readonly string[],
  nullable: readonly string[] = [],
): Record<string, string> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    pluginUiFailure("creative_project_ui_action_invalid");
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!fields.includes(key))
      pluginUiFailure("creative_project_ui_action_invalid");
    if (value === null && nullable.includes(key)) continue;
    if (["limit", "afterBriefRevision", "afterAssetRevision"].includes(key)) {
      raw[key] = String(numeric(value, key === "limit" ? 1 : 0));
    } else {
      if (typeof value !== "string")
        pluginUiFailure("creative_project_ui_action_invalid");
      raw[key] = value;
    }
  }
  return raw;
}
function projectQuery(input: unknown): CreativeProjectUiListQuery {
  const raw = rawQuery(input, ["state", "cursor", "limit"], ["cursor"]);
  const parsed = parseCreativeProjectListQuery(raw);
  return Object.freeze({
    state: parsed.state,
    cursor: raw.cursor ?? null,
    limit: parsed.limit,
  });
}
function briefQuery(input: unknown): ProjectBriefUiListQuery {
  return parseProjectBriefListQuery(
    rawQuery(input, ["afterBriefRevision", "limit"]),
  );
}
function assetQuery(input: unknown): ConceptAssetUiListQuery {
  return parseConceptAssetListQuery(
    rawQuery(input, ["afterAssetId", "limit"], ["afterAssetId"]),
  );
}
function revisionQuery(input: unknown): ConceptRevisionUiListQuery {
  return parseConceptRevisionListQuery(
    rawQuery(input, ["afterAssetRevision", "limit"]),
  );
}

/** Validates only detached business metadata; this does not authorize an invocation. */
export function parseCreativeProjectUiActionRequest<
  Action extends CreativeProjectUiAction,
>(
  input: CreativeProjectUiActionRequestFor<Action>,
): CreativeProjectUiActionRequestFor<Action>;
export function parseCreativeProjectUiActionRequest(
  input: unknown,
): CreativeProjectUiActionRequest;
export function parseCreativeProjectUiActionRequest(
  input: unknown,
): CreativeProjectUiActionRequest {
  const envelope = pluginUiFields(input, ["action", "input"]);
  if (
    typeof envelope.action !== "string" ||
    !(CREATIVE_PROJECT_UI_ACTIONS as readonly string[]).includes(
      envelope.action,
    )
  )
    pluginUiFailure("creative_project_ui_action_invalid");
  // Match the existing services.invoke input budget, excluding the host envelope.
  const copied = parsePluginUiJsonValue(envelope.input, {
    maxBytes: 24 * 1024,
  });
  const action = envelope.action as CreativeProjectUiAction;
  switch (action) {
    case "crewon.creative-projects.v1.listProjects": {
      const value = pluginUiFields(copied, ["query"]);
      return Object.freeze({
        action,
        input: Object.freeze({ query: projectQuery(value.query) }),
      });
    }
    case "crewon.creative-projects.v1.getProject": {
      const value = pluginUiFields(copied, ["projectId"]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
        }),
      });
    }
    case "crewon.creative-projects.v1.createProject": {
      const value = pluginUiFields(copied, ["request", "idempotencyKey"]);
      return Object.freeze({
        action,
        input: Object.freeze({
          request: parseCreateCreativeProjectRequest(value.request),
          idempotencyKey: parseCreativeProjectIdempotencyKey(
            value.idempotencyKey,
          ),
        }),
      });
    }
    case "crewon.creative-projects.v1.renameProject": {
      const value = pluginUiFields(copied, [
        "projectId",
        "request",
        "idempotencyKey",
      ]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          request: parseRenameCreativeProjectRequest(value.request),
          idempotencyKey: parseCreativeProjectIdempotencyKey(
            value.idempotencyKey,
          ),
        }),
      });
    }
    case "crewon.creative-projects.v1.setProjectState": {
      const value = pluginUiFields(copied, [
        "projectId",
        "request",
        "idempotencyKey",
      ]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          request: parseSetCreativeProjectStateRequest(value.request),
          idempotencyKey: parseCreativeProjectIdempotencyKey(
            value.idempotencyKey,
          ),
        }),
      });
    }
    case "crewon.creative-projects.v1.appendBrief": {
      const value = pluginUiFields(copied, [
        "projectId",
        "request",
        "idempotencyKey",
      ]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          request: parseAppendProjectBriefRequest(value.request),
          idempotencyKey: parseCreativeProjectIdempotencyKey(
            value.idempotencyKey,
          ),
        }),
      });
    }
    case "crewon.creative-projects.v1.getBrief": {
      const value = pluginUiFields(copied, ["projectId", "briefRevision"]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          briefRevision: parseCreativeProjectRevision(
            numeric(value.briefRevision, 1),
          ),
        }),
      });
    }
    case "crewon.creative-projects.v1.listBriefs": {
      const value = pluginUiFields(copied, ["projectId", "query"]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          query: briefQuery(value.query),
        }),
      });
    }
    case "crewon.creative-projects.v1.createConcept": {
      const value = pluginUiFields(copied, [
        "projectId",
        "request",
        "idempotencyKey",
      ]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          request: parseCreateConceptAssetRequest(value.request),
          idempotencyKey: parseCreativeProjectIdempotencyKey(
            value.idempotencyKey,
          ),
        }),
      });
    }
    case "crewon.creative-projects.v1.getConceptAsset": {
      const value = pluginUiFields(copied, ["projectId", "assetId"]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          assetId: parseCreativeProjectId(value.assetId),
        }),
      });
    }
    case "crewon.creative-projects.v1.listConceptAssets": {
      const value = pluginUiFields(copied, ["projectId", "query"]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          query: assetQuery(value.query),
        }),
      });
    }
    case "crewon.creative-projects.v1.appendConceptRevision": {
      const value = pluginUiFields(copied, [
        "projectId",
        "assetId",
        "request",
        "idempotencyKey",
      ]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          assetId: parseCreativeProjectId(value.assetId),
          request: parseAppendConceptAssetRevisionRequest(value.request),
          idempotencyKey: parseCreativeProjectIdempotencyKey(
            value.idempotencyKey,
          ),
        }),
      });
    }
    case "crewon.creative-projects.v1.getConceptRevision": {
      const value = pluginUiFields(copied, [
        "projectId",
        "assetId",
        "assetRevision",
      ]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          assetId: parseCreativeProjectId(value.assetId),
          assetRevision: parseCreativeProjectRevision(
            numeric(value.assetRevision, 1),
          ),
        }),
      });
    }
    case "crewon.creative-projects.v1.listConceptRevisions": {
      const value = pluginUiFields(copied, ["projectId", "assetId", "query"]);
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId: parseCreativeProjectId(value.projectId),
          assetId: parseCreativeProjectId(value.assetId),
          query: revisionQuery(value.query),
        }),
      });
    }
  }
}

export function parseCreativeProjectUiActionResponse<
  Action extends CreativeProjectUiAction,
>(
  request: CreativeProjectUiActionRequestFor<Action>,
  output: unknown,
): CreativeProjectUiResponseMap[Action];
export function parseCreativeProjectUiActionResponse(
  request: CreativeProjectUiActionRequest,
  output: unknown,
): CreativeProjectUiActionResponse;
export function parseCreativeProjectUiActionResponse(
  request: CreativeProjectUiActionRequest,
  output: unknown,
): CreativeProjectUiActionResponse {
  // Revalidate the expectation so raw caller data cannot weaken response identity checks.
  const checked = parseCreativeProjectUiActionRequest(request as unknown);
  switch (checked.action) {
    case "crewon.creative-projects.v1.listProjects":
      return parseCreativeProjectListResponse(
        output,
        parseCreativeProjectListQuery(
          rawQuery(
            checked.input.query,
            ["state", "cursor", "limit"],
            ["cursor"],
          ),
        ),
      );
    case "crewon.creative-projects.v1.getProject":
      return parseGetCreativeProjectResponse(output, checked.input);
    case "crewon.creative-projects.v1.createProject":
      return parseCreativeProjectMutationResponse(output, {
        kind: "create-project",
        request: checked.input.request,
      });
    case "crewon.creative-projects.v1.renameProject":
      return parseCreativeProjectMutationResponse(output, {
        kind: "rename-project",
        projectId: checked.input.projectId,
        request: checked.input.request,
      });
    case "crewon.creative-projects.v1.setProjectState":
      return parseCreativeProjectMutationResponse(output, {
        kind: "set-project-state",
        projectId: checked.input.projectId,
        request: checked.input.request,
      });
    case "crewon.creative-projects.v1.appendBrief":
      return parseCreativeProjectMutationResponse(output, {
        kind: "append-brief",
        projectId: checked.input.projectId,
        request: checked.input.request,
      });
    case "crewon.creative-projects.v1.getBrief":
      return parseGetProjectBriefResponse(output, checked.input);
    case "crewon.creative-projects.v1.listBriefs":
      return parseProjectBriefListResponse(output, {
        projectId: checked.input.projectId,
        ...parseProjectBriefListQuery(
          rawQuery(checked.input.query, ["afterBriefRevision", "limit"]),
        ),
      });
    case "crewon.creative-projects.v1.createConcept":
      return parseCreativeProjectMutationResponse(output, {
        kind: "create-concept",
        projectId: checked.input.projectId,
        request: checked.input.request,
      });
    case "crewon.creative-projects.v1.getConceptAsset":
      return parseGetConceptAssetResponse(output, checked.input);
    case "crewon.creative-projects.v1.listConceptAssets":
      return parseConceptAssetListResponse(output, {
        projectId: checked.input.projectId,
        ...parseConceptAssetListQuery(
          rawQuery(
            checked.input.query,
            ["afterAssetId", "limit"],
            ["afterAssetId"],
          ),
        ),
      });
    case "crewon.creative-projects.v1.appendConceptRevision":
      return parseCreativeProjectMutationResponse(output, {
        kind: "append-concept",
        projectId: checked.input.projectId,
        assetId: checked.input.assetId,
        request: checked.input.request,
      });
    case "crewon.creative-projects.v1.getConceptRevision":
      return parseGetConceptRevisionResponse(output, checked.input);
    case "crewon.creative-projects.v1.listConceptRevisions":
      return parseConceptRevisionListResponse(output, {
        projectId: checked.input.projectId,
        assetId: checked.input.assetId,
        ...parseConceptRevisionListQuery(
          rawQuery(checked.input.query, ["afterAssetRevision", "limit"]),
        ),
      });
  }
}
