import type {
  PublicProjectFoundationRunScope,
  ProjectFoundationToolsProposalMetadata,
  ProjectFoundationToolsTextPage,
} from "@crewon/contracts/project-foundation-tools";
import type {
  PublicProjectFoundation,
  PublicProjectSource,
  PublicProjectSourceChapter,
} from "@crewon/contracts/project-foundation";
import type {
  ProjectFoundation,
  ProjectFoundationRunAdmission,
  ProjectProposal,
  ProjectSource,
  ProjectSourceChapter,
} from "@crewon/domain";
import { foundationOwnerDenied } from "./project-foundation-owner-support.ts";

/** Scope hints are not authorization, and contain no actor, installation or private marker. */
export function projectFoundationToolScope(
  record: ProjectFoundationRunAdmission,
): PublicProjectFoundationRunScope {
  return {
    projectId: record.projectId,
    threadId: record.threadId,
    runId: record.runId,
    bindingId: record.bindingId,
    bindingRevision: record.bindingRevision,
    foundationRevision: record.foundationRevision,
    parametersRevision: record.parametersRevision,
    parametersDigest: record.parametersDigest,
    source: record.source,
    confirmedProposal: record.confirmedProposal,
    latestProposal: record.latestProposal,
    allowedOperations: record.allowedOperations,
    contentDigest: record.contentDigest,
  };
}

export function projectFoundationToolFoundation(
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

export function projectFoundationToolSource(
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

export function projectFoundationToolChapter(
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

/** Metadata ACK/history never echoes the proposal body. */
export function projectFoundationToolProposal(
  record: ProjectProposal,
): ProjectFoundationToolsProposalMetadata {
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId,
    revision: record.revision,
    kind: record.kind,
    foundationRevision: record.foundationRevision,
    parametersRevision: record.parametersRevision,
    source: record.source,
    contentDigest: record.contentDigest,
    characterLength: Array.from(record.text).length,
    createdAt: record.createdAt,
  };
}

export function projectFoundationToolTextPage(
  text: string,
  startOffset: number,
  limit: number,
): ProjectFoundationToolsTextPage {
  const scalars = Array.from(text);
  if (startOffset > scalars.length) foundationOwnerDenied();
  const endOffset = Math.min(scalars.length, startOffset + limit);
  return {
    startOffset,
    endOffset,
    content: scalars.slice(startOffset, endOffset).join(""),
    nextOffset: endOffset < scalars.length ? endOffset : null,
    characterLength: scalars.length,
  };
}
