import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  parsePublicCreativeProject,
  parsePublicProjectBrief,
} from "./creative-project-control-response.ts";
import {
  foundationChecked,
  foundationContractFail,
  foundationEnum,
  foundationNumber,
  foundationPointerEquals,
  foundationScalarLength,
} from "./project-foundation-contract-support.ts";
import {
  parsePublicProjectFoundation,
  parsePublicProjectSource,
  parsePublicProjectSourceChapter,
  parsePublicProjectProposal,
} from "./project-foundation-public-contract.ts";
import {
  parseProjectFoundationUiRequest,
  projectFoundationUiMethod,
} from "./project-foundation-ui-request-contract.ts";
import {
  MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES,
  type ProjectFoundationUiMethod,
  type ProjectFoundationUiRequest,
  type ProjectFoundationUiResponseFor,
  type ProjectFoundationMutationResponse,
  type ProjectFoundationUiInputMap,
} from "./plugin-project-foundation-service.ts";

export function parseProjectFoundationUiResponse<
  R extends ProjectFoundationUiRequest,
>(input: unknown, expected: R): ProjectFoundationUiResponseFor<R> {
  return foundationChecked(() => {
    const request = parseProjectFoundationUiRequest(expected);
    const method = projectFoundationUiMethod(request.action);
    const value = parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES,
    });
    let result: unknown;
    const projectId =
      "projectId" in request.input ? request.input.projectId : null;
    switch (method) {
      case "createProject":
      case "updateParameters":
      case "appendSource":
      case "saveProposal":
      case "confirmProposal":
      case "chooseCreativeStartMode":
        result = mutation(value, request, method);
        break;
      case "getFoundation": {
        const body = pluginUiFields(value, ["foundation"]);
        const foundation =
          body.foundation === null
            ? null
            : parsePublicProjectFoundation(body.foundation);
        if (foundation !== null && foundation.projectId !== projectId)
          foundationContractFail();
        result = Object.freeze({ foundation });
        break;
      }
      case "getSource": {
        const body = pluginUiFields(value, ["source"]);
        const source =
          body.source === null ? null : parsePublicProjectSource(body.source);
        const query = request.input as ProjectFoundationUiInputMap["getSource"];
        if (
          source !== null &&
          (source.projectId !== projectId ||
            source.revision !== query.sourceRevision)
        )
          foundationContractFail();
        result = Object.freeze({ source });
        break;
      }
      case "readSourcePage": {
        const body = pluginUiFields(value, ["page"]);
        const page = pluginUiFields(body.page, [
          "sourceRevision",
          "startOffset",
          "endOffset",
          "content",
          "nextOffset",
        ]);
        const query =
          request.input as ProjectFoundationUiInputMap["readSourcePage"];
        const sourceRevision = foundationNumber(page.sourceRevision);
        const startOffset = foundationNumber(page.startOffset, 0, 20_000_000);
        const endOffset = foundationNumber(page.endOffset, 0, 20_000_000);
        const actualContent = sourcePageContent(page.content);
        const nextOffset =
          page.nextOffset === null
            ? null
            : foundationNumber(page.nextOffset, 1, 20_000_000);
        if (
          sourceRevision !== query.sourceRevision ||
          startOffset !== query.startOffset ||
          endOffset - startOffset !== foundationScalarLength(actualContent) ||
          endOffset - startOffset > query.limit ||
          (nextOffset !== null &&
            (nextOffset !== endOffset ||
              endOffset - startOffset !== query.limit))
        )
          foundationContractFail();
        result = Object.freeze({
          page: Object.freeze({
            sourceRevision,
            startOffset,
            endOffset,
            content: actualContent,
            nextOffset,
          }),
        });
        break;
      }
      case "listSourceChapters": {
        const body = pluginUiFields(value, ["chapters", "nextStartOffset"]);
        const query =
          request.input as ProjectFoundationUiInputMap["listSourceChapters"];
        if (!Array.isArray(body.chapters) || body.chapters.length > query.limit)
          foundationContractFail();
        const chapters = body.chapters.map(parsePublicProjectSourceChapter);
        const seen = new Set<string>();
        for (let i = 0; i < chapters.length; i++) {
          const chapter = chapters[i]!;
          if (
            chapter.projectId !== projectId ||
            chapter.sourceRevision !== query.sourceRevision ||
            (query.afterStartOffset !== null &&
              chapter.startOffset <= query.afterStartOffset) ||
            seen.has(chapter.chapterId) ||
            (i > 0 && chapter.startOffset < chapters[i - 1]!.endOffset)
          )
            foundationContractFail();
          seen.add(chapter.chapterId);
        }
        const nextStartOffset =
          body.nextStartOffset === null
            ? null
            : foundationNumber(body.nextStartOffset, 0, 20_000_000);
        if (
          nextStartOffset !== null &&
          (chapters.length !== query.limit ||
            nextStartOffset !== chapters.at(-1)?.startOffset)
        )
          foundationContractFail();
        result = Object.freeze({
          chapters: Object.freeze(chapters),
          nextStartOffset,
        });
        break;
      }
      case "getProposal": {
        const body = pluginUiFields(value, ["proposal"]);
        const proposal =
          body.proposal === null
            ? null
            : parsePublicProjectProposal(body.proposal);
        const query =
          request.input as ProjectFoundationUiInputMap["getProposal"];
        if (
          proposal !== null &&
          (proposal.projectId !== projectId ||
            proposal.revision !== query.proposalRevision)
        )
          foundationContractFail();
        result = Object.freeze({ proposal });
        break;
      }
      case "listProposals": {
        const body = pluginUiFields(value, ["proposals", "nextRevision"]);
        const query =
          request.input as ProjectFoundationUiInputMap["listProposals"];
        if (
          !Array.isArray(body.proposals) ||
          body.proposals.length > query.limit
        )
          foundationContractFail();
        const proposals = body.proposals.map(parsePublicProjectProposal);
        for (let i = 0; i < proposals.length; i++)
          if (
            proposals[i]!.projectId !== projectId ||
            proposals[i]!.revision <=
              (i === 0
                ? query.afterProposalRevision
                : proposals[i - 1]!.revision)
          )
            foundationContractFail();
        const nextRevision =
          body.nextRevision === null
            ? null
            : foundationNumber(body.nextRevision);
        if (
          nextRevision !== null &&
          (proposals.length !== query.limit ||
            nextRevision !== proposals.at(-1)?.revision)
        )
          foundationContractFail();
        result = Object.freeze({
          proposals: Object.freeze(proposals),
          nextRevision,
        });
        break;
      }
    }
    return result as ProjectFoundationUiResponseFor<R>;
  });
}

function mutation(
  input: unknown,
  request: ProjectFoundationUiRequest,
  method: ProjectFoundationUiMethod,
): ProjectFoundationMutationResponse {
  const body = pluginUiFields(input, [
    "kind",
    "disposition",
    "project",
    "foundation",
    "brief",
    "source",
    "proposal",
  ]);
  const kind = foundationEnum(body.kind, [
    "create-project",
    "update-parameters",
    "append-source",
    "save-proposal",
    "confirm-proposal",
    "choose-direct-script",
  ]);
  const expectedKind = {
    createProject: "create-project",
    updateParameters: "update-parameters",
    appendSource: "append-source",
    saveProposal: "save-proposal",
    confirmProposal: "confirm-proposal",
    chooseCreativeStartMode: "choose-direct-script",
  };
  if (
    !(method in expectedKind) ||
    kind !== expectedKind[method as keyof typeof expectedKind]
  )
    foundationContractFail();
  const disposition = foundationEnum(body.disposition, [
    "committed",
    "replayed",
  ]);
  const project = parsePublicCreativeProject(body.project);
  const foundation = parsePublicProjectFoundation(body.foundation);
  const brief =
    body.brief === null ? null : parsePublicProjectBrief(body.brief);
  const source =
    body.source === null ? null : parsePublicProjectSource(body.source);
  const proposal =
    body.proposal === null ? null : parsePublicProjectProposal(body.proposal);
  for (const record of [foundation, brief, source, proposal])
    if (record !== null && record.projectId !== project.projectId)
      foundationContractFail();
  if (
    "projectId" in request.input &&
    request.input.projectId !== project.projectId
  )
    foundationContractFail();
  if (project.state !== "active") foundationContractFail();
  if ("expectedFoundationRevision" in request.input) {
    const expected = request.input.expectedFoundationRevision;
    if (
      foundation.revision !== expected &&
      foundation.revision !== expected + 1
    )
      foundationContractFail();
  }
  const proposedKind =
    foundation.origin === "novel" ? "novel-adaptation" : "creative-plan";
  if (proposal !== null && proposal.kind !== proposedKind)
    foundationContractFail();
  switch (method) {
    case "createProject": {
      const command =
        request.input as ProjectFoundationUiInputMap["createProject"];
      if (
        foundation.revision !== 1 ||
        foundation.parametersRevision !== 1 ||
        foundation.confirmedProposal !== null ||
        proposal !== null ||
        project.revision !== 2 ||
        project.latestBriefRevision !== 1 ||
        project.title !== command.title ||
        foundation.origin !== command.origin ||
        foundation.creativeStartMode !== command.creativeStartMode ||
        !parametersEqual(foundation.parameters, command.parameters) ||
        brief === null ||
        brief.briefRevision !== 1 ||
        brief.text !== command.briefText ||
        (command.sourceUpload === null
          ? source !== null || foundation.source !== null
          : source === null ||
            source.fileDigest !== command.sourceUpload.fileDigest)
      )
        foundationContractFail();
      if (
        source !== null &&
        (source.revision !== 1 ||
          !foundationPointerEquals(foundation.source, {
            revision: source.revision,
            digest: source.digest,
          }))
      )
        foundationContractFail();
      break;
    }
    case "appendSource": {
      const command =
        request.input as ProjectFoundationUiInputMap["appendSource"];
      if (
        source === null ||
        source.fileDigest !== command.sourceUpload.fileDigest ||
        !foundationPointerEquals(foundation.source, {
          revision: source.revision,
          digest: source.digest,
        }) ||
        foundation.revision !== command.expectedFoundationRevision + 1 ||
        foundation.confirmedProposal !== null ||
        brief !== null ||
        proposal !== null
      )
        foundationContractFail();
      break;
    }
    case "updateParameters": {
      const command =
        request.input as ProjectFoundationUiInputMap["updateParameters"];
      if (
        !parametersEqual(foundation.parameters, command.parameters) ||
        brief !== null ||
        source !== null ||
        proposal !== null ||
        (foundation.revision === command.expectedFoundationRevision + 1 &&
          foundation.confirmedProposal !== null)
      )
        foundationContractFail();
      break;
    }
    case "saveProposal": {
      const command =
        request.input as ProjectFoundationUiInputMap["saveProposal"];
      if (
        proposal === null ||
        proposal.revision !== command.expectedProposalRevision + 1 ||
        proposal.text !== command.text ||
        proposal.kind !== command.kind ||
        foundation.revision !== command.expectedFoundationRevision ||
        proposal.foundationRevision !== foundation.revision ||
        proposal.parametersRevision !== foundation.parametersRevision ||
        !foundationPointerEquals(proposal.source, foundation.source) ||
        brief !== null ||
        source !== null
      )
        foundationContractFail();
      break;
    }
    case "confirmProposal": {
      const command =
        request.input as ProjectFoundationUiInputMap["confirmProposal"];
      if (
        proposal === null ||
        proposal.revision !== command.proposalRevision ||
        proposal.contentDigest !== command.proposalDigest ||
        proposal.foundationRevision !== foundation.revision - 1 ||
        proposal.parametersRevision !== foundation.parametersRevision ||
        !foundationPointerEquals(proposal.source, foundation.source) ||
        !foundationPointerEquals(foundation.confirmedProposal, {
          revision: proposal.revision,
          digest: proposal.contentDigest,
        }) ||
        brief !== null ||
        source !== null
      )
        foundationContractFail();
      break;
    }
    case "chooseCreativeStartMode": {
      const command =
        request.input as ProjectFoundationUiInputMap["chooseCreativeStartMode"];
      if (
        foundation.origin !== "creative" ||
        foundation.creativeStartMode !== command.creativeStartMode ||
        (foundation.revision === command.expectedFoundationRevision + 1 &&
          foundation.confirmedProposal !== null) ||
        brief !== null ||
        source !== null ||
        proposal !== null
      )
        foundationContractFail();
      break;
    }
    default:
      foundationContractFail();
  }
  return Object.freeze({
    kind,
    disposition,
    project,
    foundation,
    brief,
    source,
    proposal,
  });
}

function parametersEqual(left: unknown, right: unknown): boolean {
  // Both parsers construct every parameter field in the same fixed order, including adaptation.
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourcePageContent(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 4096 ||
    new TextEncoder().encode(input).length > 4096 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  )
    foundationContractFail();
  foundationScalarLength(input);
  return input;
}
