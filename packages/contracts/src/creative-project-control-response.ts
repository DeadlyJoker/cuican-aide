import {
  creativeControlArray,
  creativeControlBrief,
  creativeControlCompareIds,
  creativeControlCopy,
  creativeControlDigest,
  creativeControlFailure,
  creativeControlId,
  creativeControlRecord,
  creativeControlRevision,
  creativeControlText,
  creativeControlTimestamp,
  creativeControlTitle,
} from "./creative-project-control-support.ts";
import {
  formatCreativeProjectCursor,
  parseCreativeProjectListQuery,
} from "./creative-project-control-contract.ts";
import type {
  ConceptAssetListQuery,
  ConceptAssetListResponse,
  ConceptRevisionListQuery,
  ConceptRevisionListResponse,
  CreativeProjectBriefMutationResponse,
  CreativeProjectConceptMutationResponse,
  CreativeProjectListQuery,
  CreativeProjectListResponse,
  CreativeProjectMetadataMutationResponse,
  CreativeProjectMutationExpectation,
  CreativeProjectMutationResponse,
  GetConceptAssetResponse,
  GetConceptRevisionResponse,
  GetCreativeProjectResponse,
  GetProjectBriefResponse,
  ProjectBriefListQuery,
  ProjectBriefListResponse,
  PublicConceptAsset,
  PublicConceptRevision,
  PublicCreativeProject,
  PublicProjectBrief,
} from "./creative-project-control-types.ts";

export function parsePublicCreativeProject(
  input: unknown,
): PublicCreativeProject {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "projectId",
    "kind",
    "title",
    "revision",
    "state",
    "latestBriefRevision",
    "createdAt",
    "updatedAt",
  ]);
  if (
    value.kind !== "short-drama" ||
    (value.state !== "active" && value.state !== "archived")
  )
    creativeControlFailure();
  const revision = creativeControlRevision(value.revision);
  const latestBriefRevision = creativeControlRevision(
    value.latestBriefRevision,
    0,
  );
  if (latestBriefRevision >= revision) creativeControlFailure();
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    kind: "short-drama",
    title: creativeControlTitle(value.title),
    revision,
    state: value.state,
    latestBriefRevision,
    createdAt: creativeControlTimestamp(value.createdAt),
    updatedAt: creativeControlTimestamp(value.updatedAt),
  });
}
export function parsePublicProjectBrief(input: unknown): PublicProjectBrief {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "projectId",
    "briefRevision",
    "text",
    "contentDigest",
    "createdAt",
  ]);
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    briefRevision: creativeControlRevision(value.briefRevision),
    text: creativeControlBrief(value.text),
    contentDigest: creativeControlDigest(value.contentDigest),
    createdAt: creativeControlTimestamp(value.createdAt),
  });
}
export function parsePublicConceptAsset(input: unknown): PublicConceptAsset {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "projectId",
    "assetId",
    "name",
    "revision",
    "latestAssetRevision",
    "createdAt",
    "updatedAt",
  ]);
  const revision = creativeControlRevision(value.revision),
    latestAssetRevision = creativeControlRevision(value.latestAssetRevision);
  if (latestAssetRevision > revision) creativeControlFailure();
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    assetId: creativeControlId(value.assetId),
    name: creativeControlTitle(value.name),
    revision,
    latestAssetRevision,
    createdAt: creativeControlTimestamp(value.createdAt),
    updatedAt: creativeControlTimestamp(value.updatedAt),
  });
}
export function parsePublicConceptRevision(
  input: unknown,
): PublicConceptRevision {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "projectId",
    "assetId",
    "assetRevision",
    "briefRevision",
    "briefContentDigest",
    "prompt",
    "contentDigest",
    "createdAt",
  ]);
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    assetId: creativeControlId(value.assetId),
    assetRevision: creativeControlRevision(value.assetRevision),
    briefRevision: creativeControlRevision(value.briefRevision),
    briefContentDigest: creativeControlDigest(value.briefContentDigest),
    prompt: creativeControlText(value.prompt, 2000),
    contentDigest: creativeControlDigest(value.contentDigest),
    createdAt: creativeControlTimestamp(value.createdAt),
  });
}
export function parseGetCreativeProjectResponse(
  input: unknown,
  expected?: Readonly<{ projectId: string }>,
): GetCreativeProjectResponse {
  const value = creativeControlRecord(creativeControlCopy(input), ["project"]);
  const project = parsePublicCreativeProject(value.project);
  if (expected && project.projectId !== expected.projectId)
    creativeControlFailure();
  return Object.freeze({ project });
}
export function parseGetProjectBriefResponse(
  input: unknown,
  expected?: Readonly<{ projectId: string; briefRevision: number }>,
): GetProjectBriefResponse {
  const value = creativeControlRecord(creativeControlCopy(input), ["brief"]);
  const brief = parsePublicProjectBrief(value.brief);
  if (
    expected &&
    (brief.projectId !== expected.projectId ||
      brief.briefRevision !== expected.briefRevision)
  )
    creativeControlFailure();
  return Object.freeze({ brief });
}
export function parseGetConceptAssetResponse(
  input: unknown,
  expected?: Readonly<{ projectId: string; assetId: string }>,
): GetConceptAssetResponse {
  const value = creativeControlRecord(creativeControlCopy(input), ["asset"]);
  const asset = parsePublicConceptAsset(value.asset);
  if (
    expected &&
    (asset.projectId !== expected.projectId ||
      asset.assetId !== expected.assetId)
  )
    creativeControlFailure();
  return Object.freeze({ asset });
}
export function parseGetConceptRevisionResponse(
  input: unknown,
  expected?: Readonly<{
    projectId: string;
    assetId: string;
    assetRevision: number;
  }>,
): GetConceptRevisionResponse {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "assetRevision",
  ]);
  const assetRevision = parsePublicConceptRevision(value.assetRevision);
  if (
    expected &&
    (assetRevision.projectId !== expected.projectId ||
      assetRevision.assetId !== expected.assetId ||
      assetRevision.assetRevision !== expected.assetRevision)
  )
    creativeControlFailure();
  return Object.freeze({ assetRevision });
}
function limit(input: number): number {
  if (!Number.isSafeInteger(input) || input < 1 || input > 50)
    creativeControlFailure();
  return input;
}
export function parseCreativeProjectListResponse(
  input: unknown,
  query: CreativeProjectListQuery,
): CreativeProjectListResponse {
  if (!["active", "archived", "all"].includes(query.state))
    creativeControlFailure();
  const value = creativeControlRecord(creativeControlCopy(input), [
    "projects",
    "nextCursor",
  ]);
  const projects = Object.freeze(
    creativeControlArray(value.projects, limit(query.limit)).map(
      parsePublicCreativeProject,
    ),
  );
  let previous = query.after;
  for (const project of projects) {
    if (query.state !== "all" && project.state !== query.state)
      creativeControlFailure();
    if (
      previous &&
      !(
        project.updatedAt < previous.updatedAt ||
        (project.updatedAt === previous.updatedAt &&
          creativeControlCompareIds(project.projectId, previous.projectId) < 0)
      )
    )
      creativeControlFailure();
    previous = project;
  }
  if (
    new Set(projects.map((project) => project.projectId)).size !==
    projects.length
  )
    creativeControlFailure();
  let nextCursor: string | null = null;
  if (value.nextCursor !== null) {
    const parsed = parseCreativeProjectListQuery({
      state: query.state,
      cursor: value.nextCursor,
    });
    const last = projects.at(-1);
    if (
      !last ||
      !parsed.after ||
      parsed.after.projectId !== last.projectId ||
      parsed.after.updatedAt !== last.updatedAt
    )
      creativeControlFailure();
    nextCursor = formatCreativeProjectCursor(query.state, lastCursor(last));
  }
  return Object.freeze({ projects, nextCursor });
}
function lastCursor(project: PublicCreativeProject) {
  return { updatedAt: project.updatedAt, projectId: project.projectId };
}
export function parseProjectBriefListResponse(
  input: unknown,
  query: ProjectBriefListQuery & Readonly<{ projectId: string }>,
): ProjectBriefListResponse {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "briefs",
    "nextAfterBriefRevision",
  ]);
  const briefs = Object.freeze(
    creativeControlArray(value.briefs, limit(query.limit)).map(
      parsePublicProjectBrief,
    ),
  );
  let previous = creativeControlRevision(query.afterBriefRevision, 0);
  for (const brief of briefs) {
    if (brief.projectId !== query.projectId || brief.briefRevision <= previous)
      creativeControlFailure();
    previous = brief.briefRevision;
  }
  const nextAfterBriefRevision =
    value.nextAfterBriefRevision === null
      ? null
      : creativeControlRevision(value.nextAfterBriefRevision);
  if (
    nextAfterBriefRevision !== null &&
    (briefs.length === 0 ||
      nextAfterBriefRevision !== briefs.at(-1)!.briefRevision)
  )
    creativeControlFailure();
  return Object.freeze({ briefs, nextAfterBriefRevision });
}
export function parseConceptAssetListResponse(
  input: unknown,
  query: ConceptAssetListQuery & Readonly<{ projectId: string }>,
): ConceptAssetListResponse {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "assets",
    "nextAfterAssetId",
  ]);
  const assets = Object.freeze(
    creativeControlArray(value.assets, limit(query.limit)).map(
      parsePublicConceptAsset,
    ),
  );
  let previous = query.afterAssetId;
  for (const asset of assets) {
    if (
      asset.projectId !== query.projectId ||
      (previous !== null &&
        creativeControlCompareIds(asset.assetId, previous) <= 0)
    )
      creativeControlFailure();
    previous = asset.assetId;
  }
  const nextAfterAssetId =
    value.nextAfterAssetId === null
      ? null
      : creativeControlId(value.nextAfterAssetId);
  if (
    nextAfterAssetId !== null &&
    (assets.length === 0 || nextAfterAssetId !== assets.at(-1)!.assetId)
  )
    creativeControlFailure();
  return Object.freeze({ assets, nextAfterAssetId });
}
export function parseConceptRevisionListResponse(
  input: unknown,
  query: ConceptRevisionListQuery &
    Readonly<{ projectId: string; assetId: string }>,
): ConceptRevisionListResponse {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "revisions",
    "nextAfterAssetRevision",
  ]);
  const revisions = Object.freeze(
    creativeControlArray(value.revisions, limit(query.limit)).map(
      parsePublicConceptRevision,
    ),
  );
  let previous = creativeControlRevision(query.afterAssetRevision, 0);
  for (const revision of revisions) {
    if (
      revision.projectId !== query.projectId ||
      revision.assetId !== query.assetId ||
      revision.assetRevision <= previous
    )
      creativeControlFailure();
    previous = revision.assetRevision;
  }
  const nextAfterAssetRevision =
    value.nextAfterAssetRevision === null
      ? null
      : creativeControlRevision(value.nextAfterAssetRevision);
  if (
    nextAfterAssetRevision !== null &&
    (revisions.length === 0 ||
      nextAfterAssetRevision !== revisions.at(-1)!.assetRevision)
  )
    creativeControlFailure();
  return Object.freeze({ revisions, nextAfterAssetRevision });
}

export function parseCreativeProjectMutationResponse(
  input: unknown,
  expected: Extract<
    CreativeProjectMutationExpectation,
    { kind: "create-project" | "append-brief" }
  >,
): CreativeProjectBriefMutationResponse;
export function parseCreativeProjectMutationResponse(
  input: unknown,
  expected: Extract<
    CreativeProjectMutationExpectation,
    { kind: "create-concept" | "append-concept" }
  >,
): CreativeProjectConceptMutationResponse;
export function parseCreativeProjectMutationResponse(
  input: unknown,
  expected: Extract<
    CreativeProjectMutationExpectation,
    { kind: "rename-project" | "set-project-state" }
  >,
): CreativeProjectMetadataMutationResponse;
export function parseCreativeProjectMutationResponse(
  input: unknown,
  expected?: CreativeProjectMutationExpectation,
): CreativeProjectMutationResponse;
export function parseCreativeProjectMutationResponse(
  input: unknown,
  expected?: CreativeProjectMutationExpectation,
): CreativeProjectMutationResponse {
  const copied = creativeControlCopy(input);
  const fields = ["disposition", "project"];
  if (copied && typeof copied === "object" && Object.hasOwn(copied, "brief"))
    fields.push("brief");
  if (copied && typeof copied === "object" && Object.hasOwn(copied, "asset"))
    fields.push("asset", "assetRevision");
  const value = creativeControlRecord(copied, fields);
  if (value.disposition !== "committed" && value.disposition !== "replayed")
    creativeControlFailure();
  const project = parsePublicCreativeProject(value.project);
  let response: CreativeProjectMutationResponse = {
    disposition: value.disposition,
    project,
  };
  if (Object.hasOwn(value, "brief")) {
    if (Object.hasOwn(value, "asset")) creativeControlFailure();
    const brief = parsePublicProjectBrief(value.brief);
    if (
      brief.projectId !== project.projectId ||
      brief.briefRevision !== project.latestBriefRevision ||
      brief.createdAt !== project.updatedAt
    )
      creativeControlFailure();
    response = { ...response, brief };
  }
  if (Object.hasOwn(value, "asset")) {
    const asset = parsePublicConceptAsset(value.asset),
      assetRevision = parsePublicConceptRevision(value.assetRevision);
    if (
      asset.projectId !== project.projectId ||
      assetRevision.projectId !== project.projectId ||
      assetRevision.assetId !== asset.assetId ||
      assetRevision.assetRevision !== asset.latestAssetRevision ||
      assetRevision.briefRevision > project.latestBriefRevision ||
      assetRevision.createdAt !== asset.updatedAt ||
      asset.updatedAt !== project.updatedAt
    )
      creativeControlFailure();
    response = { ...response, asset, assetRevision };
  }
  if (expected) assertMutation(response, expected);
  return Object.freeze(response);
}
function assertMutation(
  response: CreativeProjectMutationResponse,
  expected: CreativeProjectMutationExpectation,
): void {
  const { project } = response;
  if (expected.kind === "create-project") {
    if (
      !("brief" in response) ||
      project.title !== expected.request.title ||
      project.state !== "active" ||
      project.revision !== 2 ||
      project.latestBriefRevision !== 1 ||
      response.brief.text !== expected.request.briefText ||
      response.brief.createdAt !== project.createdAt
    )
      creativeControlFailure();
    return;
  }
  if (project.projectId !== expected.projectId) creativeControlFailure();
  const revision = expected.request.expectedProjectRevision;
  if (
    expected.kind === "rename-project" ||
    expected.kind === "set-project-state"
  ) {
    if (
      "brief" in response ||
      "asset" in response ||
      (project.revision !== revision && project.revision !== revision + 1)
    )
      creativeControlFailure();
    if (
      expected.kind === "rename-project" &&
      project.title !== expected.request.title
    )
      creativeControlFailure();
    if (
      expected.kind === "set-project-state" &&
      project.state !== expected.request.state
    )
      creativeControlFailure();
    return;
  }
  if (project.revision !== revision + 1 || project.state !== "active")
    creativeControlFailure();
  if (expected.kind === "append-brief") {
    if (!("brief" in response) || response.brief.text !== expected.request.text)
      creativeControlFailure();
    return;
  }
  if (
    !("asset" in response) ||
    response.assetRevision.briefRevision !== expected.request.briefRevision ||
    response.assetRevision.prompt !== expected.request.prompt
  )
    creativeControlFailure();
  if (expected.kind === "create-concept") {
    if (
      response.asset.name !== expected.request.name ||
      response.asset.revision !== 1 ||
      response.asset.latestAssetRevision !== 1
    )
      creativeControlFailure();
  } else if (
    response.asset.assetId !== expected.assetId ||
    response.asset.revision !==
      expected.request.expectedAssetMetadataRevision + 1
  )
    creativeControlFailure();
}
