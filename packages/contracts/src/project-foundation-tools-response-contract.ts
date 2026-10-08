import { pluginUiFields } from "./plugin-ui-json.ts";
import {
  foundationEnum,
  foundationNumber,
  foundationScalarLength,
} from "./project-foundation-contract-support.ts";
import {
  parsePublicProjectFoundation,
  parsePublicProjectSource,
  parsePublicProjectSourceChapter,
} from "./project-foundation-public-contract.ts";
import {
  foundationToolsChecked,
  foundationToolsCopy,
  foundationToolsFail,
  parseFoundationToolsProposalMetadata,
  parseFoundationToolsScope,
  parseFoundationToolsTextPage,
} from "./project-foundation-tools-contract-support.ts";
import { parseProjectFoundationToolsRequest } from "./project-foundation-tools-request-contract.ts";
import {
  PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS,
  type ProjectFoundationToolsRequest,
  type ProjectFoundationToolsResponseFor,
} from "./plugin-project-foundation-tools-service.ts";

/** Whitelisted correlated data, never an installation/Run qualification or committed authority. */
export function parseProjectFoundationToolsResponse<
  R extends ProjectFoundationToolsRequest,
>(input: unknown, expected: R): ProjectFoundationToolsResponseFor<R> {
  return foundationToolsChecked(() => {
    const e = parseProjectFoundationToolsRequest(expected);
    const copied = foundationToolsCopy(
      input,
      PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS[e.operation],
    );
    if (e.operation === "foundation_scope") {
      const v = pluginUiFields(copied, ["scope"]);
      return Object.freeze({ scope: parseFoundationToolsScope(v.scope) });
    }
    if (e.operation === "foundation_read") {
      const v = pluginUiFields(copied, ["foundation"]);
      const foundation = parsePublicProjectFoundation(v.foundation);
      if (foundation.projectId !== e.request.projectId) foundationToolsFail();
      return Object.freeze({ foundation });
    }
    if (e.operation === "foundation_source") {
      const v = pluginUiFields(copied, ["source"]);
      const source = parsePublicProjectSource(v.source);
      if (
        source.projectId !== e.request.projectId ||
        source.revision !== e.request.sourceRevision ||
        source.digest !== e.request.sourceDigest
      )
        foundationToolsFail();
      return Object.freeze({ source });
    }
    if (e.operation === "foundation_source_page") {
      const v = pluginUiFields(copied, [
        "sourceRevision",
        "sourceDigest",
        "page",
      ]);
      if (
        v.sourceRevision !== e.request.sourceRevision ||
        v.sourceDigest !== e.request.sourceDigest
      )
        foundationToolsFail();
      return Object.freeze({
        sourceRevision: e.request.sourceRevision,
        sourceDigest: e.request.sourceDigest,
        page: parseFoundationToolsTextPage(v.page, e.request, 20_000_000),
      });
    }
    if (e.operation === "foundation_chapters") {
      const v = pluginUiFields(copied, ["chapters", "nextStartOffset"]);
      if (!Array.isArray(v.chapters) || v.chapters.length > e.request.limit)
        foundationToolsFail();
      const chapters = v.chapters.map(parsePublicProjectSourceChapter);
      const ids = new Set<string>();
      let previousEnd = -1;
      for (const chapter of chapters) {
        if (
          chapter.projectId !== e.request.projectId ||
          chapter.sourceRevision !== e.request.sourceRevision ||
          (e.request.afterStartOffset !== undefined &&
            chapter.startOffset <= e.request.afterStartOffset) ||
          chapter.startOffset < previousEnd ||
          ids.has(chapter.chapterId)
        )
          foundationToolsFail();
        ids.add(chapter.chapterId);
        previousEnd = chapter.endOffset;
      }
      const nextStartOffset =
        v.nextStartOffset === null
          ? null
          : foundationNumber(v.nextStartOffset, 0, 20_000_000);
      if (
        nextStartOffset !== null &&
        (chapters.length !== e.request.limit ||
          nextStartOffset !== chapters.at(-1)?.startOffset)
      )
        foundationToolsFail();
      return Object.freeze({
        chapters: Object.freeze(chapters),
        nextStartOffset,
      });
    }
    if (e.operation === "foundation_proposal") {
      const v = pluginUiFields(copied, ["proposal", "page"]);
      if (v.proposal === null) {
        if (v.page !== null) foundationToolsFail();
        return Object.freeze({ proposal: null, page: null });
      }
      const proposal = parseFoundationToolsProposalMetadata(v.proposal);
      if (
        proposal.projectId !== e.request.projectId ||
        proposal.revision !== e.request.proposalRevision ||
        proposal.contentDigest !== e.request.proposalDigest
      )
        foundationToolsFail();
      const page = parseFoundationToolsTextPage(v.page, e.request, 8192);
      if (
        page.characterLength !== proposal.characterLength ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(page.content)
      )
        foundationToolsFail();
      return Object.freeze({ proposal, page });
    }
    if (e.operation === "foundation_proposals") {
      const v = pluginUiFields(copied, ["proposals", "nextRevision"]);
      if (!Array.isArray(v.proposals) || v.proposals.length > e.request.limit)
        foundationToolsFail();
      const proposals = v.proposals.map(parseFoundationToolsProposalMetadata);
      let previousRevision = e.request.afterProposalRevision;
      for (const proposal of proposals) {
        if (
          proposal.projectId !== e.request.projectId ||
          proposal.revision <= previousRevision
        )
          foundationToolsFail();
        previousRevision = proposal.revision;
      }
      const nextRevision =
        v.nextRevision === null ? null : foundationNumber(v.nextRevision);
      if (
        nextRevision !== null &&
        (proposals.length !== e.request.limit ||
          nextRevision !== proposals.at(-1)?.revision)
      )
        foundationToolsFail();
      return Object.freeze({
        proposals: Object.freeze(proposals),
        nextRevision,
      });
    }
    const v = pluginUiFields(copied, [
      "kind",
      "disposition",
      "foundationRevision",
      "proposal",
    ]);
    if (
      v.kind !== "save-proposal" ||
      v.foundationRevision !== e.request.expectedFoundationRevision
    )
      foundationToolsFail();
    const disposition = foundationEnum(v.disposition, [
      "committed",
      "replayed",
    ]);
    const proposal = parseFoundationToolsProposalMetadata(v.proposal);
    if (
      proposal.projectId !== e.request.projectId ||
      proposal.revision !== e.request.expectedProposalRevision + 1 ||
      proposal.kind !== e.request.kind ||
      proposal.foundationRevision !== e.request.expectedFoundationRevision ||
      proposal.characterLength !== foundationScalarLength(e.request.text)
    )
      foundationToolsFail();
    return Object.freeze({
      kind: "save-proposal" as const,
      disposition,
      foundationRevision: e.request.expectedFoundationRevision,
      proposal,
    });
  }) as ProjectFoundationToolsResponseFor<R>;
}
