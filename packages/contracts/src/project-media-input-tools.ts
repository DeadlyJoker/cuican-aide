import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFields as fields,
} from "./plugin-ui-json.ts";
import {
  assetContractId as id,
  assetContractRevision as revision,
  assetContractDigest as digest,
} from "./project-asset-contract-support.ts";
import {
  parseSaveMediaInputRequest,
  parseLoadMediaInputRequest,
  parseSaveMediaInputResponse,
  parseLoadMediaInputResponse,
  type SaveMediaInputRequest,
  type LoadMediaInputRequest,
  type PublicMediaInput,
} from "./project-media-inputs.ts";
import {
  parseListMediaInputsRequest,
  parseListMediaInputsResponse,
  parseMediaInputOptionsRequest,
  parseMediaInputOptionsResponse,
  type ListMediaInputsRequest,
  type ListMediaInputsResponse,
  type MediaInputOptionsRequest,
  type MediaInputOptionsResponse,
} from "./project-media-input-catalog.ts";

/** Independent optional Node service. UI invocation and execution v1 grant no access to it. */
export const PROJECT_MEDIA_INPUT_TOOLS_SERVICE =
  "crewon.project-media-input-tools";
export const PROJECT_MEDIA_INPUT_TOOLS_API_VERSION = "1";
export const MAX_MEDIA_INPUT_TOOL_RESPONSE_BYTES = 8192;
export const MEDIA_INPUT_TOOL_METHODS = [
  "getContext",
  "getOptions",
  "listInputs",
  "getInput",
  "readPrompt",
  "saveInput",
] as const;
export type MediaInputToolMethod = (typeof MEDIA_INPUT_TOOL_METHODS)[number];
export type MediaInputToolMetadata = Omit<PublicMediaInput, "prompt">;
export type MediaInputToolContext = Readonly<{
  projectId: string;
  runId: string;
  threadId: string;
  workspaceId: string | null;
  bindingRevision: number;
  workflowId: PublicMediaInput["workflowId"];
  configurationRevision: number;
  briefRevision: number;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
  }> | null;
}>;
export type MediaInputToolRequests = Readonly<{
  getContext: Readonly<Record<string, never>>;
  getOptions: MediaInputOptionsRequest;
  listInputs: ListMediaInputsRequest;
  getInput: LoadMediaInputRequest;
  readPrompt: Readonly<{
    projectId: string;
    mediaInputId: string;
    inputRevision: number;
    offset: number;
  }>;
  saveInput: Omit<SaveMediaInputRequest, "idempotencyKey">;
}>;
export type MediaInputToolResponses = Readonly<{
  getContext: MediaInputToolContext;
  getOptions: MediaInputOptionsResponse;
  listInputs: ListMediaInputsResponse;
  getInput: Readonly<{
    state: Readonly<{
      input: MediaInputToolMetadata;
      latestInputRevision: number;
    }> | null;
  }>;
  readPrompt: Readonly<{
    projectId: string;
    mediaInputId: string;
    inputRevision: number;
    contentDigest: string;
    offset: number;
    nextOffset: number | null;
    totalCodePoints: number;
    text: string;
  }>;
  saveInput: Readonly<{
    disposition: "committed" | "replayed";
    input: MediaInputToolMetadata;
  }>;
}>;
export type PluginProjectMediaInputToolsService = Readonly<{
  [M in MediaInputToolMethod]: (
    input: Readonly<{ command: unknown; request: MediaInputToolRequests[M] }>,
  ) => Promise<MediaInputToolResponses[M]>;
}>;
const validationKey = "host-only-media-input-validation";
const omittedPrompt = "Prompt omitted from bounded metadata acknowledgement.";
function fail(): never {
  throw new ContractValidationError(
    "project_media_input_tools_contract_invalid",
  );
}
function plain(input: unknown, maximum: number) {
  return parsePluginUiJsonValue(input, { maxBytes: maximum });
}
export function parseMediaInputToolRequest<M extends MediaInputToolMethod>(
  method: M,
  input: unknown,
): MediaInputToolRequests[M] {
  const value = plain(input, 16384);
  let result: unknown;
  switch (method) {
    case "getContext":
      result = Object.freeze(fields(value, []));
      break;
    case "getOptions":
      result = parseMediaInputOptionsRequest(value);
      break;
    case "listInputs": {
      const request = parseListMediaInputsRequest(value);
      if (request.limit > 4) fail();
      result = request;
      break;
    }
    case "getInput":
      result = parseLoadMediaInputRequest(value);
      break;
    case "readPrompt": {
      const r = fields(value, [
        "projectId",
        "mediaInputId",
        "inputRevision",
        "offset",
      ]);
      result = Object.freeze({
        projectId: id(r.projectId),
        mediaInputId: id(r.mediaInputId),
        inputRevision: revision(r.inputRevision),
        offset: revision(r.offset, 0, 8192),
      });
      break;
    }
    case "saveInput": {
      const r = fields(value, [
        "projectId",
        "mediaInputId",
        "expectedInputRevision",
        "item",
        "briefRevision",
        "script",
        "workflowId",
        "configurationRevision",
        "prompt",
        "references",
      ]);
      const { idempotencyKey: _key, ...request } = parseSaveMediaInputRequest({
        ...r,
        idempotencyKey: validationKey,
      });
      result = Object.freeze(request);
      break;
    }
    default:
      return fail();
  }
  return result as MediaInputToolRequests[M];
}
export type MediaInputToolCommand = {
  [M in MediaInputToolMethod]: Readonly<{
    method: M;
    request: MediaInputToolRequests[M];
  }>;
}[MediaInputToolMethod];
/** One declared tool, with an exact discriminant and bounded JSON arguments; no user-provided command key. */
export function parseMediaInputToolCommand(
  input: unknown,
): MediaInputToolCommand {
  const r = fields(plain(input, 32768), ["method", "requestJson"]);
  if (
    !MEDIA_INPUT_TOOL_METHODS.includes(r.method as MediaInputToolMethod) ||
    typeof r.requestJson !== "string"
  )
    fail();
  const method = r.method as MediaInputToolMethod;
  return Object.freeze({
    method,
    request: parseMediaInputToolRequest(method, JSON.parse(r.requestJson)),
  }) as MediaInputToolCommand;
}
function metadata(input: unknown): MediaInputToolMetadata {
  const r = fields(input, [
    "projectId",
    "mediaInputId",
    "inputRevision",
    "item",
    "briefRevision",
    "script",
    "workflowId",
    "configurationRevision",
    "references",
    "createdAt",
    "contentDigest",
  ]);
  const state = parseLoadMediaInputResponse(
    {
      projectId: id(r.projectId),
      mediaInputId: id(r.mediaInputId),
      inputRevision: revision(r.inputRevision),
    },
    {
      state: {
        input: { ...r, prompt: omittedPrompt },
        latestInputRevision: r.inputRevision,
      },
    },
  ).state!;
  const { prompt: _prompt, ...result } = state.input;
  return Object.freeze(result);
}
export function assertMediaInputToolResponseBudget(value: unknown): void {
  const resultJson = JSON.stringify(value);
  if (
    typeof resultJson !== "string" ||
    new TextEncoder().encode(JSON.stringify({ resultJson })).byteLength >
      MAX_MEDIA_INPUT_TOOL_RESPONSE_BYTES
  )
    fail();
}
export function parseMediaInputToolResponse<M extends MediaInputToolMethod>(
  method: M,
  requestInput: MediaInputToolRequests[M],
  input: unknown,
): MediaInputToolResponses[M] {
  const request = parseMediaInputToolRequest(method, requestInput);
  const copy = plain(input, MAX_MEDIA_INPUT_TOOL_RESPONSE_BYTES);
  let result: unknown;
  switch (method) {
    case "getContext": {
      const r = fields(copy, [
        "projectId",
        "runId",
        "threadId",
        "workspaceId",
        "bindingRevision",
        "workflowId",
        "configurationRevision",
        "briefRevision",
        "script",
      ]);
      if (
        r.workflowId !== "krea2-reference-four-view" &&
        r.workflowId !== "flux2-three-reference-storyboard"
      )
        fail();
      const s =
        r.script === null
          ? null
          : fields(r.script, ["artifactId", "episodeId", "contentRevision"]);
      if (r.workflowId === "flux2-three-reference-storyboard" && s === null)
        fail();
      result = Object.freeze({
        projectId: id(r.projectId),
        runId: id(r.runId),
        threadId: id(r.threadId),
        workspaceId: r.workspaceId === null ? null : id(r.workspaceId),
        bindingRevision: revision(r.bindingRevision),
        workflowId: r.workflowId,
        configurationRevision: revision(r.configurationRevision),
        briefRevision: revision(r.briefRevision),
        script:
          s === null
            ? null
            : Object.freeze({
                artifactId: id(s.artifactId),
                episodeId: id(s.episodeId),
                contentRevision: revision(s.contentRevision),
              }),
      });
      break;
    }
    case "getOptions":
      result = parseMediaInputOptionsResponse(copy);
      break;
    case "listInputs":
      result = parseListMediaInputsResponse(
        request as ListMediaInputsRequest,
        copy,
      );
      break;
    case "getInput": {
      const r = fields(copy, ["state"]);
      if (r.state === null) {
        result = Object.freeze({ state: null });
        break;
      }
      const s = fields(r.state, ["input", "latestInputRevision"]),
        m = metadata(s.input);
      const checked = parseLoadMediaInputResponse(
        request as LoadMediaInputRequest,
        {
          state: {
            input: { ...m, prompt: omittedPrompt },
            latestInputRevision: s.latestInputRevision,
          },
        },
      ).state!;
      result = Object.freeze({
        state: Object.freeze({
          input: m,
          latestInputRevision: checked.latestInputRevision,
        }),
      });
      break;
    }
    case "saveInput": {
      const r = fields(copy, ["disposition", "input"]),
        m = metadata(r.input);
      const checked = parseSaveMediaInputResponse(
        {
          ...(request as MediaInputToolRequests["saveInput"]),
          idempotencyKey: validationKey,
          prompt: omittedPrompt,
        },
        { disposition: r.disposition, input: { ...m, prompt: omittedPrompt } },
      );
      result = Object.freeze({ disposition: checked.disposition, input: m });
      break;
    }
    case "readPrompt": {
      const q = request as MediaInputToolRequests["readPrompt"];
      const r = fields(copy, [
        "projectId",
        "mediaInputId",
        "inputRevision",
        "contentDigest",
        "offset",
        "nextOffset",
        "totalCodePoints",
        "text",
      ]);
      const total = revision(r.totalCodePoints, 1, 8192),
        offset = revision(r.offset, 0, total);
      if (
        typeof r.text !== "string" ||
        new TextEncoder().encode(r.text).byteLength > 2048 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(r.text)
      )
        fail();
      const points = [...r.text];
      if (
        points.some((p) => {
          const n = p.codePointAt(0)!;
          return n >= 0xd800 && n <= 0xdfff;
        })
      )
        fail();
      const end = offset + points.length;
      if (
        end > total ||
        (end < total && points.length === 0) ||
        r.nextOffset !== (end === total ? null : end) ||
        q.offset !== offset ||
        q.projectId !== id(r.projectId) ||
        q.mediaInputId !== id(r.mediaInputId) ||
        q.inputRevision !== revision(r.inputRevision)
      )
        fail();
      result = Object.freeze({
        ...q,
        contentDigest: digest(r.contentDigest),
        nextOffset: r.nextOffset as number | null,
        totalCodePoints: total,
        text: r.text,
      });
      break;
    }
    default:
      return fail();
  }
  assertMediaInputToolResponseBudget(result);
  return result as MediaInputToolResponses[M];
}

/** The saved prompt is read separately; its omitted value can never consume an unbounded Tool result. */
export function mediaInputToolMetadata(
  input: PublicMediaInput,
): MediaInputToolMetadata {
  const { prompt: _prompt, ...value } = input;
  return metadata(value);
}
