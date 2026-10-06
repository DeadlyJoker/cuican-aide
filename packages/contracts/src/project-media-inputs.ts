import { ContractValidationError } from "./contract-validation-error.ts";
import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  assetContractId as id,
  assetContractRevision as revision,
  assetContractDigest as digest,
  assetContractTimestamp as timestamp,
  assetContractText as text,
} from "./project-asset-contract-support.ts";

/** Independent logical metadata protocol; neither SDK v1 nor the execution service is extended. */
export const PROJECT_MEDIA_INPUTS_PROTOCOL = "crewon.project-media-inputs.v1";
export const MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES = 16 * 1024;
export const MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES = 24 * 1024;
export type MediaInputWorkflowId =
  | "krea2-reference-four-view"
  | "flux2-three-reference-storyboard";
export type MediaInputRole =
  | "character"
  | "scene"
  | "characterOne"
  | "characterTwo";
export type MediaInputItem =
  | Readonly<{ kind: "character-reference"; assetId: string }>
  | Readonly<{ kind: "storyboard-frame-exploration"; episodeId: string }>;
export type MediaInputReference = Readonly<{
  projectId: string;
  assetId: string;
  kind: "character" | "scene";
  expectedAssetRevision: number;
  contentRevision: number;
  referenceRevision: number;
}>;
type Content = Readonly<{
  projectId: string;
  item: MediaInputItem;
  briefRevision: number;
  script: Readonly<{ artifactId: string; contentRevision: number }> | null;
  workflowId: MediaInputWorkflowId;
  configurationRevision: number;
  prompt: string;
  references: Readonly<Partial<Record<MediaInputRole, MediaInputReference>>>;
}>;
export type SaveMediaInputRequest = Content &
  Readonly<{
    mediaInputId: string | null;
    expectedInputRevision: number;
    idempotencyKey: string;
  }>;
export type LoadMediaInputRequest = Readonly<{
  projectId: string;
  mediaInputId: string;
  inputRevision: number | null;
}>;
export type PublicMediaInput = Content &
  Readonly<{
    mediaInputId: string;
    inputRevision: number;
    createdAt: string;
    contentDigest: string;
  }>;
export type SaveMediaInputResponse = Readonly<{
  disposition: "committed" | "replayed";
  input: PublicMediaInput;
}>;
export type LoadMediaInputResponse = Readonly<{
  state: Readonly<{
    input: PublicMediaInput;
    latestInputRevision: number;
  }> | null;
}>;
const contentFields = [
  "projectId",
  "item",
  "briefRevision",
  "script",
  "workflowId",
  "configurationRevision",
  "prompt",
  "references",
];
const record = pluginUiFields;
function checked<T>(
  input: unknown,
  maxBytes: number,
  parse: (copy: unknown) => T,
): T {
  try {
    return parse(parsePluginUiJsonValue(input, { maxBytes }));
  } catch {
    throw new ContractValidationError("project_media_inputs_contract_invalid");
  }
}
function invalid(): never {
  throw new ContractValidationError("project_media_inputs_contract_invalid");
}
function content(r: Readonly<Record<string, unknown>>): Content {
  const projectId = id(r.projectId),
    workflowId = r.workflowId;
  if (
    workflowId !== "krea2-reference-four-view" &&
    workflowId !== "flux2-three-reference-storyboard"
  )
    invalid();
  const itemFields =
    workflowId === "krea2-reference-four-view"
      ? ["kind", "assetId"]
      : ["kind", "episodeId"];
  const i = record(r.item, itemFields);
  let item: MediaInputItem;
  if (workflowId === "krea2-reference-four-view") {
    if (i.kind !== "character-reference") invalid();
    item = Object.freeze({ kind: i.kind, assetId: id(i.assetId) });
  } else {
    if (i.kind !== "storyboard-frame-exploration") invalid();
    item = Object.freeze({ kind: i.kind, episodeId: id(i.episodeId) });
  }
  const s =
    r.script === null
      ? null
      : record(r.script, ["artifactId", "contentRevision"]);
  const script =
    s === null
      ? null
      : Object.freeze({
          artifactId: id(s.artifactId),
          contentRevision: revision(s.contentRevision),
        });
  if (workflowId === "flux2-three-reference-storyboard" && script === null)
    invalid();
  const roles: MediaInputRole[] =
    workflowId === "krea2-reference-four-view"
      ? ["character"]
      : ["scene", "characterOne", "characterTwo"];
  const refs = record(r.references, roles);
  const references: Partial<Record<MediaInputRole, MediaInputReference>> = {};
  for (const role of roles) {
    const v = record(refs[role], [
      "projectId",
      "assetId",
      "kind",
      "expectedAssetRevision",
      "contentRevision",
      "referenceRevision",
    ]);
    const kind = role === "scene" ? "scene" : "character";
    if (v.kind !== kind || id(v.projectId) !== projectId) invalid();
    references[role] = Object.freeze({
      projectId,
      assetId: id(v.assetId),
      kind,
      expectedAssetRevision: revision(v.expectedAssetRevision),
      contentRevision: revision(v.contentRevision),
      referenceRevision: revision(v.referenceRevision),
    });
  }
  if (
    new Set(roles.map((role) => references[role]!.assetId)).size !==
      roles.length ||
    (item.kind === "character-reference" &&
      item.assetId !== references.character!.assetId)
  )
    invalid();
  return Object.freeze({
    projectId,
    item,
    briefRevision: revision(r.briefRevision),
    script,
    workflowId,
    configurationRevision: revision(r.configurationRevision),
    prompt: text(r.prompt, 8192),
    references: Object.freeze(references),
  });
}
export function parseSaveMediaInputRequest(
  input: unknown,
): SaveMediaInputRequest {
  return checked(input, MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES, (copy) => {
    const r = record(copy, [
      ...contentFields,
      "mediaInputId",
      "expectedInputRevision",
      "idempotencyKey",
    ]);
    const mediaInputId = r.mediaInputId === null ? null : id(r.mediaInputId);
    const expectedInputRevision = revision(r.expectedInputRevision, 0);
    if ((mediaInputId === null) !== (expectedInputRevision === 0)) invalid();
    return Object.freeze({
      ...content(r),
      mediaInputId,
      expectedInputRevision,
      idempotencyKey: id(r.idempotencyKey),
    });
  });
}
export function parseLoadMediaInputRequest(
  input: unknown,
): LoadMediaInputRequest {
  return checked(input, 1024, (copy) => {
    const r = record(copy, ["projectId", "mediaInputId", "inputRevision"]);
    return Object.freeze({
      projectId: id(r.projectId),
      mediaInputId: id(r.mediaInputId),
      inputRevision:
        r.inputRevision === null ? null : revision(r.inputRevision),
    });
  });
}
/** HTTP envelope: route ownership and the original header key are never accepted from the body. */
export function parseSaveMediaInputHttpRequest(
  input: Readonly<{
    projectId: unknown;
    body: unknown;
    idempotencyKey: unknown;
  }>,
): SaveMediaInputRequest {
  return checked(input.body, MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES, (copy) => {
    const r = record(copy, [
      ...contentFields.filter((key) => key !== "projectId"),
      "mediaInputId",
      "expectedInputRevision",
    ]);
    return parseSaveMediaInputRequest({
      ...r,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    });
  });
}
export function parseLoadMediaInputHttpRequest(
  input: Readonly<{
    projectId: unknown;
    mediaInputId: unknown;
    query: unknown;
  }>,
): LoadMediaInputRequest {
  return checked(input.query, 1024, (copy) => {
    if (copy === null || typeof copy !== "object" || Array.isArray(copy))
      invalid();
    const r = record(
      copy,
      Object.hasOwn(copy, "inputRevision") ? ["inputRevision"] : [],
    );
    if (!Object.hasOwn(r, "inputRevision"))
      return parseLoadMediaInputRequest({
        projectId: input.projectId,
        mediaInputId: input.mediaInputId,
        inputRevision: null,
      });
    if (
      typeof r.inputRevision !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(r.inputRevision)
    )
      invalid();
    return parseLoadMediaInputRequest({
      projectId: input.projectId,
      mediaInputId: input.mediaInputId,
      inputRevision: Number(r.inputRevision),
    });
  });
}
function publicInput(input: unknown): PublicMediaInput {
  const r = record(input, [
    ...contentFields,
    "mediaInputId",
    "inputRevision",
    "createdAt",
    "contentDigest",
  ]);
  return Object.freeze({
    ...content(r),
    mediaInputId: id(r.mediaInputId),
    inputRevision: revision(r.inputRevision),
    createdAt: timestamp(r.createdAt),
    contentDigest: digest(r.contentDigest),
  });
}
export function parseSaveMediaInputResponse(
  requestInput: SaveMediaInputRequest,
  input: unknown,
): SaveMediaInputResponse {
  const request = parseSaveMediaInputRequest(requestInput);
  return checked(input, MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES, (copy) => {
    const r = record(copy, ["disposition", "input"]);
    if (r.disposition !== "committed" && r.disposition !== "replayed")
      invalid();
    const result = publicInput(r.input);
    if (
      (request.mediaInputId !== null &&
        result.mediaInputId !== request.mediaInputId) ||
      result.inputRevision !== request.expectedInputRevision + 1 ||
      contentFields.some(
        (key) =>
          JSON.stringify(result[key as keyof Content]) !==
          JSON.stringify(request[key as keyof Content]),
      )
    )
      invalid();
    return Object.freeze({ disposition: r.disposition, input: result });
  });
}
export function parseLoadMediaInputResponse(
  requestInput: LoadMediaInputRequest,
  input: unknown,
): LoadMediaInputResponse {
  const request = parseLoadMediaInputRequest(requestInput);
  return checked(input, MAX_PROJECT_MEDIA_INPUT_RESPONSE_BYTES, (copy) => {
    const r = record(copy, ["state"]);
    if (r.state === null) return Object.freeze({ state: null });
    const state = record(r.state, ["input", "latestInputRevision"]),
      result = publicInput(state.input),
      latestInputRevision = revision(state.latestInputRevision);
    if (
      result.projectId !== request.projectId ||
      result.mediaInputId !== request.mediaInputId ||
      (request.inputRevision !== null &&
        result.inputRevision !== request.inputRevision) ||
      latestInputRevision < result.inputRevision ||
      (request.inputRevision === null &&
        latestInputRevision !== result.inputRevision)
    )
      invalid();
    return Object.freeze({
      state: Object.freeze({ input: result, latestInputRevision }),
    });
  });
}
