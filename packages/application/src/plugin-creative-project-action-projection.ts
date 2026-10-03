import {
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  type PublicCreativeProject,
  type PublicProjectBrief,
  type PublicConceptAsset,
  type PublicConceptRevision,
} from "@crewon/contracts";
import type {
  CreativeProject,
  ProjectBriefRevision,
  ConceptAsset,
  ConceptAssetRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { CreativeProjectMutationResult } from "./creative-project-store-port.ts";

/** Deliberately projects only public metadata; owner/audit fields never enter plugin JSON. */
export function creativeActionProject(
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

export function creativeActionBrief(
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

export function creativeActionAsset(value: ConceptAsset): PublicConceptAsset {
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

export function creativeActionRevision(
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

export function creativeActionMutation(result: CreativeProjectMutationResult) {
  const common = {
    disposition: result.disposition,
    project: creativeActionProject(result.project),
  };
  switch (result.kind) {
    case "create-project":
    case "append-brief":
      return { ...common, brief: creativeActionBrief(result.brief) };
    case "create-concept":
    case "append-concept":
      return {
        ...common,
        asset: creativeActionAsset(result.asset),
        assetRevision: creativeActionRevision(result.assetRevision),
      };
    case "rename-project":
    case "set-project-state":
      return common;
  }
}

/** Suffix trimming preserves immutable text and advances the cursor to the last delivered item. */
export function creativeActionPage<T, Cursor, Response>(input: {
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
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") <=
      MAX_CREATIVE_PROJECT_RESPONSE_BYTES
    ) {
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
