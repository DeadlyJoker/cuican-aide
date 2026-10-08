import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  creativeControlBrief,
  creativeControlDigest,
  creativeControlId,
  creativeControlTitle,
} from "./creative-project-control-support.ts";
import {
  foundationChecked,
  foundationContractFail,
  foundationEnum,
  foundationNumber,
  foundationOrigin,
  foundationUpload,
  parseProjectFoundationParameters,
} from "./project-foundation-contract-support.ts";
import {
  isProjectFoundationUiAction,
  MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES,
  MAX_PROJECT_FOUNDATION_PROPOSAL_PAGE_SIZE,
  MAX_PROJECT_SOURCE_UI_CHAPTER_PAGE_SIZE,
  MAX_PROJECT_SOURCE_UI_PAGE_SCALARS,
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  type ProjectFoundationUiRequest,
  type ProjectFoundationUiMethod,
} from "./plugin-project-foundation-service.ts";

export function projectFoundationUiMethod(
  action: unknown,
): ProjectFoundationUiMethod {
  if (!isProjectFoundationUiAction(action)) foundationContractFail();
  const method = (
    Object.keys(
      PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
    ) as ProjectFoundationUiMethod[]
  ).find((key) => PROJECT_FOUNDATION_UI_METHOD_ACTIONS[key] === action);
  if (method === undefined) foundationContractFail();
  return method;
}

export function parseProjectFoundationUiRequest(
  input: unknown,
): ProjectFoundationUiRequest {
  return foundationChecked(() => {
    const outer = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_FOUNDATION_UI_INPUT_BYTES,
      }),
      ["action", "input"],
    );
    const method = projectFoundationUiMethod(outer.action);
    const fields = requestFields[method];
    const value = pluginUiFields(outer.input, fields);
    const action = PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method];
    let result: unknown;
    if (method === "createProject") {
      const origin = foundationOrigin(value.origin);
      const creativeStartMode =
        origin === "creative"
          ? foundationEnum(value.creativeStartMode, [
              "confirm-plan",
              "direct-script",
            ])
          : foundationEnum(value.creativeStartMode, [null]);
      const sourceUpload =
        value.sourceUpload === null
          ? null
          : foundationUpload(value.sourceUpload);
      if (origin === "novel" && sourceUpload === null) foundationContractFail();
      result = {
        title: creativeControlTitle(value.title),
        briefText: creativeControlBrief(value.briefText),
        origin,
        parameters: parseProjectFoundationParameters(value.parameters, origin),
        creativeStartMode,
        sourceUpload,
        idempotencyKey: creativeControlId(value.idempotencyKey),
      };
    } else {
      const projectId = creativeControlId(value.projectId);
      const common = { projectId };
      const change = () => ({
        ...common,
        expectedFoundationRevision: foundationNumber(
          value.expectedFoundationRevision,
        ),
        idempotencyKey: creativeControlId(value.idempotencyKey),
      });
      const source = () => ({
        ...common,
        sourceRevision: foundationNumber(value.sourceRevision),
      });
      switch (method) {
        case "getFoundation":
          result = common;
          break;
        case "updateParameters":
          result = {
            ...change(),
            parameters: parseProjectFoundationParameters(
              value.parameters,
              null,
            ),
          };
          break;
        case "appendSource":
          result = {
            ...change(),
            sourceUpload: foundationUpload(value.sourceUpload),
          };
          break;
        case "getSource":
          result = source();
          break;
        case "readSourcePage":
          result = {
            ...source(),
            sourceDigest: creativeControlDigest(value.sourceDigest),
            startOffset: foundationNumber(value.startOffset, 0),
            limit: foundationNumber(
              value.limit,
              1,
              MAX_PROJECT_SOURCE_UI_PAGE_SCALARS,
            ),
          };
          break;
        case "listSourceChapters":
          result = {
            ...source(),
            sourceDigest: creativeControlDigest(value.sourceDigest),
            afterStartOffset:
              value.afterStartOffset === null
                ? null
                : foundationNumber(value.afterStartOffset, 0),
            limit: foundationNumber(
              value.limit,
              1,
              MAX_PROJECT_SOURCE_UI_CHAPTER_PAGE_SIZE,
            ),
          };
          break;
        case "saveProposal":
          result = {
            ...change(),
            expectedProposalRevision: foundationNumber(
              value.expectedProposalRevision,
              0,
            ),
            kind: foundationEnum(value.kind, [
              "creative-plan",
              "novel-adaptation",
            ]),
            text: creativeControlBrief(value.text),
          };
          break;
        case "confirmProposal":
          result = {
            ...change(),
            proposalRevision: foundationNumber(value.proposalRevision),
            proposalDigest: creativeControlDigest(value.proposalDigest),
          };
          break;
        case "chooseCreativeStartMode":
          result = {
            ...change(),
            creativeStartMode: foundationEnum(value.creativeStartMode, [
              "confirm-plan",
              "direct-script",
            ]),
          };
          break;
        case "getProposal":
          result = {
            ...common,
            proposalRevision: foundationNumber(value.proposalRevision),
          };
          break;
        case "listProposals":
          result = {
            ...common,
            afterProposalRevision: foundationNumber(
              value.afterProposalRevision,
              0,
            ),
            limit: foundationNumber(
              value.limit,
              1,
              MAX_PROJECT_FOUNDATION_PROPOSAL_PAGE_SIZE,
            ),
          };
          break;
      }
    }
    return Object.freeze({
      action,
      input: Object.freeze(result as object),
    }) as ProjectFoundationUiRequest;
  });
}

const changeFields = [
  "projectId",
  "expectedFoundationRevision",
  "idempotencyKey",
];
const sourceFields = ["projectId", "sourceRevision"];
const requestFields: Readonly<
  Record<ProjectFoundationUiMethod, readonly string[]>
> = Object.freeze({
  createProject: [
    "title",
    "briefText",
    "origin",
    "parameters",
    "creativeStartMode",
    "sourceUpload",
    "idempotencyKey",
  ],
  getFoundation: ["projectId"],
  updateParameters: [...changeFields, "parameters"],
  appendSource: [...changeFields, "sourceUpload"],
  getSource: sourceFields,
  readSourcePage: [...sourceFields, "sourceDigest", "startOffset", "limit"],
  listSourceChapters: [
    ...sourceFields,
    "sourceDigest",
    "afterStartOffset",
    "limit",
  ],
  saveProposal: [...changeFields, "expectedProposalRevision", "kind", "text"],
  confirmProposal: [...changeFields, "proposalRevision", "proposalDigest"],
  chooseCreativeStartMode: [...changeFields, "creativeStartMode"],
  getProposal: ["projectId", "proposalRevision"],
  listProposals: ["projectId", "afterProposalRevision", "limit"],
});
