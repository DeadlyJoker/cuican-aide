import {
  MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES,
  type ProjectFoundationMutationResponse,
  type PublicProjectFoundation,
  type PublicProjectSource,
  type PublicProjectSourceChapter,
  type PublicProjectProposal,
} from "@crewon/contracts/project-foundation";
import type {
  ProjectFoundation,
  ProjectSource,
  ProjectSourceChapter,
  ProjectProposal,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  creativeActionProject,
  creativeActionBrief,
} from "./plugin-creative-project-action-projection.ts";
import type { ProjectFoundationMutationResult } from "./project-foundation-store-port.ts";
/** Exact public fields only; owner, audit and durable upload provenance stay inside the host. */
export function foundationActionFoundation(
  record: ProjectFoundation,
): PublicProjectFoundation {
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    origin: record.origin,
    revision: record.revision,
    parametersRevision: record.parametersRevision,
    parameters: record.parameters,
    source: record.source,
    confirmedProposal: record.confirmedProposal,
    creativeStartMode: record.creativeStartMode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
export function foundationActionSource(
  record: ProjectSource,
): PublicProjectSource {
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    revision: record.revision,
    digest: record.digest,
    fileDigest: record.fileDigest,
    fileName: record.fileName,
    format: record.format,
    byteLength: record.byteLength,
    characterLength: record.characterLength,
    createdAt: record.createdAt,
  };
}
export function foundationActionChapter(
  record: ProjectSourceChapter,
): PublicProjectSourceChapter {
  return {
    projectId: record.projectId,
    sourceRevision: record.sourceRevision,
    chapterId: record.chapterId,
    title: record.title,
    startOffset: record.startOffset,
    endOffset: record.endOffset,
  };
}
export function foundationActionProposal(
  record: ProjectProposal,
): PublicProjectProposal {
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    revision: record.revision,
    kind: record.kind,
    foundationRevision: record.foundationRevision,
    parametersRevision: record.parametersRevision,
    source: record.source,
    text: record.text,
    contentDigest: record.contentDigest,
    createdAt: record.createdAt,
  };
}
export function foundationActionMutation(
  record: ProjectFoundationMutationResult,
): ProjectFoundationMutationResponse {
  return {
    kind: record.kind,
    disposition: record.disposition,
    project: creativeActionProject(record.project),
    foundation: foundationActionFoundation(record.foundation),
    brief: record.brief === null ? null : creativeActionBrief(record.brief),
    source:
      record.source === null ? null : foundationActionSource(record.source),
    proposal:
      record.proposal === null
        ? null
        : foundationActionProposal(record.proposal),
  };
}
/** Trim complete records only; a byte-bound response never advances past an omitted version. */
export function foundationActionPage<T, Cursor, Response>(
  input: Readonly<{
    items: readonly T[];
    continuation: Cursor | null;
    cursorOf(item: T): Cursor;
    response(items: readonly T[], continuation: Cursor | null): Response;
  }>,
): Response {
  const items = [...input.items];
  let continuation = input.continuation;
  while (true) {
    const response = input.response(items, continuation);
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength <=
      MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES
    )
      return response;
    if (items.length <= 1)
      throw new ApplicationError(
        "internal",
        "plugin_project_foundation_response_invalid",
      );
    items.pop();
    continuation = input.cursorOf(items.at(-1)!);
  }
}
