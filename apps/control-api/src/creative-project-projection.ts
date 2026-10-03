import { ApplicationError } from "@crewon/application";
import type { CreativeProjectMutationResult } from "@crewon/application";
import type {
  CreativeProject,
  ProjectBriefRevision,
  ConceptAsset,
  ConceptAssetRevision,
} from "@crewon/domain";
import {
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  type PublicCreativeProject,
  type PublicProjectBrief,
  type PublicConceptAsset,
  type PublicConceptRevision,
} from "@crewon/contracts";

/** The authenticated application retains ownership and audit fields; the UI gets business data. */
export function projectCreativeProject(
  value: CreativeProject,
): PublicCreativeProject {
  return {
    projectId: value.projectId,
    kind: value.kind,
    title: value.title,
    revision: value.revision,
    state: value.state,
    latestBriefRevision: value.latestBriefRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function projectCreativeBrief(
  value: ProjectBriefRevision,
): PublicProjectBrief {
  return {
    projectId: value.projectId,
    briefRevision: value.briefRevision,
    text: value.text,
    contentDigest: value.contentDigest,
    createdAt: value.createdAt,
  };
}

export function projectConceptAsset(value: ConceptAsset): PublicConceptAsset {
  return {
    projectId: value.projectId,
    assetId: value.assetId,
    name: value.name,
    revision: value.revision,
    latestAssetRevision: value.latestAssetRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function projectConceptRevision(
  value: ConceptAssetRevision,
): PublicConceptRevision {
  return {
    projectId: value.projectId,
    assetId: value.assetId,
    assetRevision: value.assetRevision,
    briefRevision: value.briefRevision,
    briefContentDigest: value.briefContentDigest,
    prompt: value.prompt,
    contentDigest: value.contentDigest,
    createdAt: value.createdAt,
  };
}

export function projectCreativeMutation(result: CreativeProjectMutationResult) {
  const common = {
    disposition: result.disposition,
    project: projectCreativeProject(result.project),
  };
  switch (result.kind) {
    case "create-project":
    case "append-brief":
      return boundedCreativeResponse({
        ...common,
        brief: projectCreativeBrief(result.brief),
      });
    case "create-concept":
    case "append-concept":
      return boundedCreativeResponse({
        ...common,
        asset: projectConceptAsset(result.asset),
        assetRevision: projectConceptRevision(result.assetRevision),
      });
    case "rename-project":
    case "set-project-state":
      return boundedCreativeResponse(common);
  }
}

export function boundedCreativeResponse<T>(response: T): T {
  if (responseBytes(response) > MAX_CREATIVE_PROJECT_RESPONSE_BYTES)
    throw new ApplicationError("internal", "creative_project_response_limit");
  return response;
}

/**
 * Trims only a suffix, never content within an immutable input. A non-null cursor
 * permits another read; it does not assert that another row exists. The original
 * bounded application read establishes whether an untrimmed page is exhausted.
 */
export function boundedCreativePage<T, Cursor, Response>(input: {
  items: readonly T[];
  continuation: Cursor | null;
  cursorOf: (item: T) => Cursor;
  response: (items: readonly T[], continuation: Cursor | null) => Response;
}): Response {
  for (let length = input.items.length; length >= 0; length--) {
    const items = input.items.slice(0, length);
    const continuation =
      length === input.items.length
        ? input.continuation
        : length === 0
          ? null
          : input.cursorOf(items[length - 1]!);
    const result = input.response(items, continuation);
    if (responseBytes(result) <= MAX_CREATIVE_PROJECT_RESPONSE_BYTES) {
      if (length === 0 && input.items.length > 0)
        throw new ApplicationError(
          "internal",
          "creative_project_response_limit",
        );
      return result;
    }
  }
  throw new ApplicationError("internal", "creative_project_response_limit");
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
