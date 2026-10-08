import { pluginUiFields } from "./plugin-ui-json.ts";
import {
  creativeControlBrief,
  creativeControlDigest,
  creativeControlId,
  creativeControlText,
  creativeControlTimestamp,
} from "./creative-project-control-support.ts";
import {
  foundationChecked,
  foundationContractFail,
  foundationEnum,
  foundationNumber,
  foundationOrigin,
  foundationPointer,
  foundationScalarLength,
  parseProjectFoundationParameters,
} from "./project-foundation-contract-support.ts";
import type {
  PublicProjectFoundation,
  PublicProjectProposal,
  PublicProjectSource,
  PublicProjectSourceChapter,
} from "./plugin-project-foundation-service.ts";

export function parsePublicProjectFoundation(
  input: unknown,
): PublicProjectFoundation {
  return foundationChecked(() => {
    const value = pluginUiFields(input, [
      "schemaVersion",
      "projectId",
      "origin",
      "revision",
      "parametersRevision",
      "parameters",
      "source",
      "confirmedProposal",
      "creativeStartMode",
      "createdAt",
      "updatedAt",
    ]);
    if (value.schemaVersion !== "crewon.project-foundation.v1")
      foundationContractFail();
    const origin = foundationOrigin(value.origin);
    const revision = foundationNumber(value.revision);
    const parametersRevision = foundationNumber(value.parametersRevision);
    const creativeStartMode =
      origin === "creative"
        ? foundationEnum(value.creativeStartMode, [
            "confirm-plan",
            "direct-script",
          ])
        : foundationEnum(value.creativeStartMode, [null]);
    const source = foundationPointer(value.source);
    const confirmedProposal = foundationPointer(value.confirmedProposal);
    if (
      parametersRevision > revision ||
      (confirmedProposal !== null &&
        (revision < 2 ||
          parametersRevision >= revision ||
          (origin === "novel" && source === null) ||
          creativeStartMode === "direct-script"))
    )
      foundationContractFail();
    return Object.freeze({
      schemaVersion: "crewon.project-foundation.v1",
      projectId: creativeControlId(value.projectId),
      origin,
      revision,
      parametersRevision,
      parameters: parseProjectFoundationParameters(value.parameters, origin),
      source,
      confirmedProposal,
      creativeStartMode,
      createdAt: creativeControlTimestamp(value.createdAt),
      updatedAt: creativeControlTimestamp(value.updatedAt),
    });
  });
}
export function parsePublicProjectSource(input: unknown): PublicProjectSource {
  return foundationChecked(() => {
    const value = pluginUiFields(input, [
      "schemaVersion",
      "projectId",
      "revision",
      "digest",
      "fileDigest",
      "fileName",
      "format",
      "byteLength",
      "characterLength",
      "createdAt",
    ]);
    if (value.schemaVersion !== "crewon.project-source.v1")
      foundationContractFail();
    const format = foundationEnum(value.format, ["txt", "md", "html"]);
    const fileName = creativeControlText(value.fileName, 510);
    if (
      fileName.trim() !== fileName ||
      foundationScalarLength(fileName) > 255 ||
      new TextEncoder().encode(fileName).length > 1024 ||
      /[\u0000-\u001f\u007f/\\]/u.test(fileName) ||
      !{ txt: /\.txt$/iu, md: /\.(?:md|markdown)$/iu, html: /\.html?$/iu }[
        format
      ].test(fileName)
    )
      foundationContractFail();
    return Object.freeze({
      schemaVersion: "crewon.project-source.v1",
      projectId: creativeControlId(value.projectId),
      revision: foundationNumber(value.revision),
      digest: creativeControlDigest(value.digest),
      fileDigest: creativeControlDigest(value.fileDigest),
      fileName,
      format,
      byteLength: foundationNumber(value.byteLength, 1, 20_000_000),
      characterLength: foundationNumber(value.characterLength, 1, 20_000_000),
      createdAt: creativeControlTimestamp(value.createdAt),
    });
  });
}
export function parsePublicProjectSourceChapter(
  input: unknown,
): PublicProjectSourceChapter {
  const value = pluginUiFields(input, [
    "projectId",
    "sourceRevision",
    "chapterId",
    "title",
    "startOffset",
    "endOffset",
  ]);
  const title = creativeControlText(value.title, 320);
  const startOffset = foundationNumber(value.startOffset, 0, 20_000_000);
  const endOffset = foundationNumber(value.endOffset, 1, 20_000_000);
  if (
    endOffset <= startOffset ||
    title.trim() !== title ||
    /[\u0000-\u001f\u007f]/u.test(title)
  )
    foundationContractFail();
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    sourceRevision: foundationNumber(value.sourceRevision),
    chapterId: creativeControlId(value.chapterId),
    title,
    startOffset,
    endOffset,
  });
}
export function parsePublicProjectProposal(
  input: unknown,
): PublicProjectProposal {
  return foundationChecked(() => {
    const value = pluginUiFields(input, [
      "schemaVersion",
      "projectId",
      "revision",
      "kind",
      "foundationRevision",
      "parametersRevision",
      "source",
      "text",
      "contentDigest",
      "createdAt",
    ]);
    if (value.schemaVersion !== "crewon.project-proposal.v1")
      foundationContractFail();
    const kind = foundationEnum(value.kind, [
      "creative-plan",
      "novel-adaptation",
    ]);
    const foundationRevision = foundationNumber(value.foundationRevision);
    const parametersRevision = foundationNumber(value.parametersRevision);
    const source = foundationPointer(value.source);
    if (
      parametersRevision > foundationRevision ||
      (kind === "novel-adaptation" && source === null)
    )
      foundationContractFail();
    return Object.freeze({
      schemaVersion: "crewon.project-proposal.v1",
      projectId: creativeControlId(value.projectId),
      revision: foundationNumber(value.revision),
      kind,
      foundationRevision,
      parametersRevision,
      source,
      text: creativeControlBrief(value.text),
      contentDigest: creativeControlDigest(value.contentDigest),
      createdAt: creativeControlTimestamp(value.createdAt),
    });
  });
}
