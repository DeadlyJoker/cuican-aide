import { pluginUiFields } from "./plugin-ui-json.ts";
import {
  creativeControlBrief,
  creativeControlDigest,
  creativeControlId,
} from "./creative-project-control-support.ts";
import {
  foundationEnum,
  foundationNumber,
} from "./project-foundation-contract-support.ts";
import {
  foundationToolsChecked,
  foundationToolsCopy,
  foundationToolsFail,
} from "./project-foundation-tools-contract-support.ts";
import {
  MAX_PROJECT_FOUNDATION_TOOLS_INPUT_BYTES,
  MAX_PROJECT_FOUNDATION_TOOLS_PAGE_SCALARS,
  MAX_PROJECT_FOUNDATION_TOOLS_CHAPTER_PAGE_SIZE,
  MAX_PROJECT_FOUNDATION_TOOLS_PROPOSAL_PAGE_SIZE,
  PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
  type ProjectFoundationToolsRequest,
} from "./plugin-project-foundation-tools-service.ts";

/** Only business JSON is detached here. The execution command is never parsed or copied. */
export function parseProjectFoundationToolsRequest(
  input: unknown,
): ProjectFoundationToolsRequest {
  return foundationToolsChecked(() => {
    const v = pluginUiFields(
      foundationToolsCopy(input, MAX_PROJECT_FOUNDATION_TOOLS_INPUT_BYTES),
      ["operation", "request"],
    );
    const operation = foundationEnum(
      v.operation,
      PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
    );
    if (operation === "foundation_scope") {
      pluginUiFields(v.request, []);
      return Object.freeze({ operation, request: Object.freeze({}) });
    }
    const fields =
      operation === "foundation_read"
        ? ["projectId"]
        : operation === "foundation_source"
          ? ["projectId", "sourceRevision", "sourceDigest"]
          : operation === "foundation_source_page"
            ? [
                "projectId",
                "sourceRevision",
                "sourceDigest",
                "startOffset",
                "limit",
              ]
            : operation === "foundation_chapters"
              ? [
                  "projectId",
                  "sourceRevision",
                  "sourceDigest",
                  "afterStartOffset",
                  "limit",
                ]
              : operation === "foundation_proposal"
                ? [
                    "projectId",
                    "proposalRevision",
                    "proposalDigest",
                    "startOffset",
                    "limit",
                  ]
                : operation === "foundation_proposals"
                  ? ["projectId", "afterProposalRevision", "limit"]
                  : [
                      "projectId",
                      "expectedFoundationRevision",
                      "expectedProposalRevision",
                      "kind",
                      "text",
                    ];
    const optionalFields =
      operation === "foundation_read"
        ? ["parametersStartOffset", "parametersLimit"]
        : [];
    const r = pluginUiFields(v.request, [
      ...(operation === "foundation_chapters" &&
      !Object.hasOwn(v.request as object, "afterStartOffset")
        ? fields.filter((field) => field !== "afterStartOffset")
        : fields),
      ...optionalFields.filter((field) =>
        Object.hasOwn(v.request as object, field),
      ),
    ]);
    const projectId = creativeControlId(r.projectId);
    if (operation === "foundation_read")
      return Object.freeze({
        operation,
        request: Object.freeze({
          projectId,
          ...(Object.hasOwn(r, "parametersStartOffset")
            ? {
                parametersStartOffset: foundationNumber(
                  r.parametersStartOffset,
                  0,
                  8192,
                ),
              }
            : {}),
          ...(Object.hasOwn(r, "parametersLimit")
            ? { parametersLimit: foundationNumber(r.parametersLimit, 1, 1024) }
            : {}),
        }),
      });
    if (
      operation === "foundation_source" ||
      operation === "foundation_source_page" ||
      operation === "foundation_chapters"
    ) {
      const sourceRevision = foundationNumber(r.sourceRevision);
      const sourceDigest = creativeControlDigest(r.sourceDigest);
      if (operation === "foundation_source")
        return Object.freeze({
          operation,
          request: Object.freeze({ projectId, sourceRevision, sourceDigest }),
        });
      if (operation === "foundation_source_page")
        return Object.freeze({
          operation,
          request: Object.freeze({
            projectId,
            sourceRevision,
            sourceDigest,
            startOffset: foundationNumber(r.startOffset, 0, 20_000_000),
            limit: foundationNumber(
              r.limit,
              1,
              MAX_PROJECT_FOUNDATION_TOOLS_PAGE_SCALARS,
            ),
          }),
        });
      return Object.freeze({
        operation,
        request: Object.freeze({
          projectId,
          sourceRevision,
          sourceDigest,
          ...(Object.hasOwn(r, "afterStartOffset")
            ? {
                afterStartOffset: foundationNumber(
                  r.afterStartOffset,
                  0,
                  20_000_000,
                ),
              }
            : {}),
          limit: foundationNumber(
            r.limit,
            1,
            MAX_PROJECT_FOUNDATION_TOOLS_CHAPTER_PAGE_SIZE,
          ),
        }),
      });
    }
    if (operation === "foundation_proposal")
      return Object.freeze({
        operation,
        request: Object.freeze({
          projectId,
          proposalRevision: foundationNumber(r.proposalRevision),
          proposalDigest: creativeControlDigest(r.proposalDigest),
          startOffset: foundationNumber(r.startOffset, 0, 8192),
          limit: foundationNumber(
            r.limit,
            1,
            MAX_PROJECT_FOUNDATION_TOOLS_PAGE_SCALARS,
          ),
        }),
      });
    if (operation === "foundation_proposals")
      return Object.freeze({
        operation,
        request: Object.freeze({
          projectId,
          afterProposalRevision: foundationNumber(r.afterProposalRevision, 0),
          limit: foundationNumber(
            r.limit,
            1,
            MAX_PROJECT_FOUNDATION_TOOLS_PROPOSAL_PAGE_SIZE,
          ),
        }),
      });
    if (operation !== "foundation_proposal_save") return foundationToolsFail();
    return Object.freeze({
      operation,
      request: Object.freeze({
        projectId,
        expectedFoundationRevision: foundationNumber(
          r.expectedFoundationRevision,
        ),
        expectedProposalRevision: foundationNumber(
          r.expectedProposalRevision,
          0,
          Number.MAX_SAFE_INTEGER - 1,
        ),
        kind: foundationEnum(r.kind, ["creative-plan", "novel-adaptation"]),
        text: creativeControlBrief(r.text),
      }),
    });
  });
}
