import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseProjectTextId,
  parseProjectTextIdempotencyKey,
  parseSaveProjectOutlineCandidateRequest,
  parseSaveProjectScriptCandidateRequest,
  parseSelectProjectTextRevisionRequest,
  parseSetProjectTextArtifactLockedRequest,
} from "./project-text-control-contract.ts";
import {
  parseGetProjectTextArtifactResponse,
  parseGetProjectTextRevisionResponse,
  parseProjectTextArtifactListResponse,
  parseProjectTextRevisionListResponse,
  parseProjectTextMutationResponse,
} from "./project-text-control-response.ts";
import {
  isProjectTextUiAction,
  MAX_PROJECT_TEXT_UI_INPUT_BYTES,
  MAX_PROJECT_TEXT_UI_RESPONSE_BYTES,
  type ProjectTextUiActionRequest,
  type ProjectTextUiCodec,
  type ProjectTextUiResponseMap,
  type ProjectTextUiAction,
} from "./plugin-project-texts-ui-service.ts";

export class PluginProjectTextUiContractError extends ContractValidationError {
  constructor() {
    super("plugin_project_text_ui_invalid");
    this.name = "PluginProjectTextUiContractError";
  }
}
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch {
    throw new PluginProjectTextUiContractError();
  }
}
function integer(
  input: unknown,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    throw new PluginProjectTextUiContractError();
  return input;
}
/** No actor, installation identity or caller-selected authorization enters this protocol. */
export function parseProjectTextUiActionRequest(
  input: unknown,
): ProjectTextUiActionRequest {
  return checked(() => {
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_TEXT_UI_INPUT_BYTES,
      }),
      ["action", "input"],
    );
    const action = value.action;
    if (!isProjectTextUiAction(action))
      throw new PluginProjectTextUiContractError();
    const fields = ["projectId"];
    switch (action) {
      case "crewon.project-texts.v1.getScript":
        fields.push("episodeId");
        break;
      case "crewon.project-texts.v1.getArtifact":
        fields.push("artifactId");
        break;
      case "crewon.project-texts.v1.getRevision":
        fields.push("artifactId", "contentRevision");
        break;
      case "crewon.project-texts.v1.listArtifacts":
        fields.push("afterArtifactId", "limit");
        break;
      case "crewon.project-texts.v1.listRevisions":
        fields.push("artifactId", "afterContentRevision", "limit");
        break;
      case "crewon.project-texts.v1.saveOutlineCandidate":
        fields.push("request", "idempotencyKey");
        break;
      case "crewon.project-texts.v1.saveScriptCandidate":
        fields.push("episodeId", "request", "idempotencyKey");
        break;
      case "crewon.project-texts.v1.selectRevision":
      case "crewon.project-texts.v1.setLocked":
        fields.push("artifactId", "request", "idempotencyKey");
        break;
      case "crewon.project-texts.v1.getOutline":
        break;
    }
    const body = pluginUiFields(value.input, fields);
    const common = { projectId: parseProjectTextId(body.projectId) };
    const artifact = () => ({
      ...common,
      artifactId: parseProjectTextId(body.artifactId),
    });
    const key = () => parseProjectTextIdempotencyKey(body.idempotencyKey);
    switch (action) {
      case "crewon.project-texts.v1.getOutline":
        return Object.freeze({ action, input: Object.freeze(common) });
      case "crewon.project-texts.v1.getScript":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...common,
            episodeId: parseProjectTextId(body.episodeId),
          }),
        });
      case "crewon.project-texts.v1.getArtifact":
        return Object.freeze({ action, input: Object.freeze(artifact()) });
      case "crewon.project-texts.v1.getRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...artifact(),
            contentRevision: integer(body.contentRevision),
          }),
        });
      case "crewon.project-texts.v1.listArtifacts":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...common,
            afterArtifactId:
              body.afterArtifactId === null
                ? null
                : parseProjectTextId(body.afterArtifactId),
            limit: integer(body.limit, 1, 16),
          }),
        });
      case "crewon.project-texts.v1.listRevisions":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...artifact(),
            afterContentRevision: integer(body.afterContentRevision, 0),
            limit: integer(body.limit, 1, 16),
          }),
        });
      case "crewon.project-texts.v1.saveOutlineCandidate":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...common,
            request: parseSaveProjectOutlineCandidateRequest(body.request),
            idempotencyKey: key(),
          }),
        });
      case "crewon.project-texts.v1.saveScriptCandidate":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...common,
            episodeId: parseProjectTextId(body.episodeId),
            request: parseSaveProjectScriptCandidateRequest(body.request),
            idempotencyKey: key(),
          }),
        });
      case "crewon.project-texts.v1.selectRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...artifact(),
            request: parseSelectProjectTextRevisionRequest(body.request),
            idempotencyKey: key(),
          }),
        });
      case "crewon.project-texts.v1.setLocked":
        return Object.freeze({
          action,
          input: Object.freeze({
            ...artifact(),
            request: parseSetProjectTextArtifactLockedRequest(body.request),
            idempotencyKey: key(),
          }),
        });
    }
  });
}

/** The original strict HTTP response parsers bind every reply to its exact requested project and revision. */
export function parseProjectTextUiActionResponse(
  requestInput: ProjectTextUiActionRequest,
  input: unknown,
): ProjectTextUiResponseMap[ProjectTextUiAction] {
  return checked(() => {
    const request = parseProjectTextUiActionRequest(requestInput);
    const value = parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_TEXT_UI_RESPONSE_BYTES,
    });
    const parsed = (() => {
      switch (request.action) {
        case "crewon.project-texts.v1.getOutline":
          return parseGetProjectTextArtifactResponse(value, {
            ...request.input,
            kind: "outline",
            episodeId: null,
          });
        case "crewon.project-texts.v1.getScript":
          return parseGetProjectTextArtifactResponse(value, {
            ...request.input,
            kind: "script",
          });
        case "crewon.project-texts.v1.getArtifact":
          return parseGetProjectTextArtifactResponse(value, request.input);
        case "crewon.project-texts.v1.getRevision":
          return parseGetProjectTextRevisionResponse(value, request.input);
        case "crewon.project-texts.v1.listArtifacts":
          return parseProjectTextArtifactListResponse(value, request.input);
        case "crewon.project-texts.v1.listRevisions":
          return parseProjectTextRevisionListResponse(value, request.input);
        case "crewon.project-texts.v1.saveOutlineCandidate":
          return parseProjectTextMutationResponse(value, {
            ...request.input,
            kind: "save-outline",
          });
        case "crewon.project-texts.v1.saveScriptCandidate":
          return parseProjectTextMutationResponse(value, {
            ...request.input,
            kind: "save-script",
          });
        case "crewon.project-texts.v1.selectRevision":
          return parseProjectTextMutationResponse(value, {
            ...request.input,
            kind: "select-revision",
          });
        case "crewon.project-texts.v1.setLocked":
          return parseProjectTextMutationResponse(value, {
            ...request.input,
            kind: "set-lock",
          });
      }
    })();
    // Parsers enforce the discriminated invariants not represented by the generated HTTP unions.
    return parsed as unknown as ProjectTextUiResponseMap[ProjectTextUiAction];
  });
}
export const projectTextsUiCodec: ProjectTextUiCodec = Object.freeze({
  parseRequest: parseProjectTextUiActionRequest,
  parseResponse: parseProjectTextUiActionResponse,
});
