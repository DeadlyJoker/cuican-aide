import { ContractValidationError } from "./contract-validation-error.ts";
import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  creativeControlDigest,
  creativeControlId,
  creativeControlTimestamp,
} from "./creative-project-control-support.ts";
import {
  foundationEnum,
  foundationNumber,
  foundationPointer,
  foundationScalarLength,
} from "./project-foundation-contract-support.ts";
import {
  PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  type ProjectFoundationToolsProposalMetadata,
  type ProjectFoundationToolsTextPage,
  type PublicProjectFoundationRunScope,
} from "./plugin-project-foundation-tools-service.ts";

export class ProjectFoundationToolsContractError extends ContractValidationError {
  constructor() {
    super("project_foundation_tools_contract_invalid");
    this.name = "ProjectFoundationToolsContractError";
  }
}
export function foundationToolsFail(): never {
  throw new ProjectFoundationToolsContractError();
}
export function foundationToolsChecked<T>(run: () => T): T {
  try {
    return run();
  } catch {
    return foundationToolsFail();
  }
}
export function foundationToolsCopy(input: unknown, maxBytes: number): unknown {
  return parsePluginUiJsonValue(input, { maxBytes });
}
export function parseFoundationToolsScope(
  input: unknown,
): PublicProjectFoundationRunScope {
  const v = pluginUiFields(input, [
    "projectId",
    "threadId",
    "runId",
    "bindingId",
    "bindingRevision",
    "foundationRevision",
    "parametersRevision",
    "parametersDigest",
    "source",
    "confirmedProposal",
    "latestProposal",
    "allowedOperations",
    "contentDigest",
  ]);
  const foundationRevision = foundationNumber(v.foundationRevision);
  const parametersRevision = foundationNumber(v.parametersRevision);
  const confirmedProposal = foundationPointer(v.confirmedProposal);
  if (
    parametersRevision > foundationRevision ||
    (confirmedProposal !== null &&
      (foundationRevision < 2 || parametersRevision >= foundationRevision)) ||
    JSON.stringify(v.allowedOperations) !==
      JSON.stringify(PROJECT_FOUNDATION_TOOL_OPERATION_IDS)
  )
    foundationToolsFail();
  return Object.freeze({
    projectId: creativeControlId(v.projectId),
    threadId: creativeControlId(v.threadId),
    runId: creativeControlId(v.runId),
    bindingId: creativeControlId(v.bindingId),
    bindingRevision: foundationNumber(v.bindingRevision),
    foundationRevision,
    parametersRevision,
    parametersDigest: creativeControlDigest(v.parametersDigest),
    source: foundationPointer(v.source),
    confirmedProposal,
    latestProposal: foundationPointer(v.latestProposal),
    allowedOperations: PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
    contentDigest: creativeControlDigest(v.contentDigest),
  });
}
export function parseFoundationToolsProposalMetadata(
  input: unknown,
): ProjectFoundationToolsProposalMetadata {
  const v = pluginUiFields(input, [
    "schemaVersion",
    "projectId",
    "revision",
    "kind",
    "foundationRevision",
    "parametersRevision",
    "source",
    "contentDigest",
    "characterLength",
    "createdAt",
  ]);
  if (v.schemaVersion !== "crewon.project-proposal.v1") foundationToolsFail();
  const kind = foundationEnum(v.kind, ["creative-plan", "novel-adaptation"]);
  const foundationRevision = foundationNumber(v.foundationRevision);
  const parametersRevision = foundationNumber(v.parametersRevision);
  const source = foundationPointer(v.source);
  if (
    parametersRevision > foundationRevision ||
    (kind === "novel-adaptation" && source === null)
  )
    foundationToolsFail();
  return Object.freeze({
    schemaVersion: "crewon.project-proposal.v1",
    projectId: creativeControlId(v.projectId),
    revision: foundationNumber(v.revision),
    kind,
    foundationRevision,
    parametersRevision,
    source,
    contentDigest: creativeControlDigest(v.contentDigest),
    characterLength: foundationNumber(v.characterLength, 1, 8192),
    createdAt: creativeControlTimestamp(v.createdAt),
  });
}
export function parseFoundationToolsTextPage(
  input: unknown,
  expected: Readonly<{ startOffset: number; limit: number }>,
  maximumLength: number,
): ProjectFoundationToolsTextPage {
  const v = pluginUiFields(input, [
    "startOffset",
    "endOffset",
    "content",
    "nextOffset",
    "characterLength",
  ]);
  const characterLength = foundationNumber(v.characterLength, 1, maximumLength);
  const startOffset = foundationNumber(v.startOffset, 0, characterLength);
  const endOffset = foundationNumber(v.endOffset, startOffset, characterLength);
  if (typeof v.content !== "string") foundationToolsFail();
  const count = foundationScalarLength(v.content);
  const nextOffset =
    v.nextOffset === null
      ? null
      : foundationNumber(v.nextOffset, 1, characterLength);
  if (
    startOffset !== expected.startOffset ||
    endOffset !== Math.min(startOffset + expected.limit, characterLength) ||
    count !== endOffset - startOffset ||
    nextOffset !== (endOffset < characterLength ? endOffset : null)
  )
    foundationToolsFail();
  return Object.freeze({
    startOffset,
    endOffset,
    content: v.content,
    nextOffset,
    characterLength,
  });
}
