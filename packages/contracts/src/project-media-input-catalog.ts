import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFields as fields,
} from "./plugin-ui-json.ts";
import {
  assetContractId as id,
  assetContractRevision as revision,
  assetContractTimestamp as timestamp,
} from "./project-asset-contract-support.ts";
import type {
  MediaInputItem,
  MediaInputWorkflowId,
} from "./project-media-inputs.ts";

export type ListMediaInputsRequest = Readonly<{
  projectId: string;
  afterMediaInputId: string | null;
  limit: number;
}>;
export type MediaInputSummary = Readonly<{
  projectId: string;
  mediaInputId: string;
  latestInputRevision: number;
  item: MediaInputItem;
  workflowId: MediaInputWorkflowId;
  createdAt: string;
}>;
export type ListMediaInputsResponse = Readonly<{
  inputs: readonly MediaInputSummary[];
  nextMediaInputId: string | null;
}>;
export type MediaInputOptionsRequest = Readonly<{ projectId: string }>;
export type MediaInputOptionsResponse = Readonly<{
  configuration: Readonly<{
    revision: number;
    workflows: readonly MediaInputWorkflowId[];
  }> | null;
}>;
export function parseMediaInputOptionsRequest(
  input: unknown,
): MediaInputOptionsRequest {
  const f = fields(parsePluginUiJsonValue(input, { maxBytes: 1024 }), [
    "projectId",
  ]);
  return Object.freeze({ projectId: id(f.projectId) });
}
export function parseMediaInputOptionsResponse(
  input: unknown,
): MediaInputOptionsResponse {
  const f = fields(parsePluginUiJsonValue(input, { maxBytes: 1024 }), [
    "configuration",
  ]);
  if (f.configuration === null) return Object.freeze({ configuration: null });
  const r = fields(f.configuration, ["revision", "workflows"]);
  if (
    !Array.isArray(r.workflows) ||
    r.workflows.length < 1 ||
    r.workflows.length > 2 ||
    new Set(r.workflows).size !== r.workflows.length ||
    r.workflows.some(
      (w) =>
        w !== "krea2-reference-four-view" &&
        w !== "flux2-three-reference-storyboard",
    )
  )
    invalid();
  return Object.freeze({
    configuration: Object.freeze({
      revision: revision(r.revision),
      workflows: Object.freeze(r.workflows as MediaInputWorkflowId[]),
    }),
  });
}
export function parseListMediaInputsRequest(
  input: unknown,
): ListMediaInputsRequest {
  const f = fields(parsePluginUiJsonValue(input, { maxBytes: 2048 }), [
    "projectId",
    "afterMediaInputId",
    "limit",
  ]);
  if (
    !Number.isSafeInteger(f.limit) ||
    (f.limit as number) < 1 ||
    (f.limit as number) > 16
  )
    invalid();
  return Object.freeze({
    projectId: id(f.projectId),
    afterMediaInputId:
      f.afterMediaInputId === null ? null : id(f.afterMediaInputId),
    limit: f.limit as number,
  });
}
export function parseListMediaInputsResponse(
  requestInput: ListMediaInputsRequest,
  input: unknown,
): ListMediaInputsResponse {
  const q = parseListMediaInputsRequest(requestInput);
  const f = fields(parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }), [
    "inputs",
    "nextMediaInputId",
  ]);
  if (!Array.isArray(f.inputs) || f.inputs.length > q.limit) invalid();
  let previous = q.afterMediaInputId;
  const inputs = f.inputs.map((entry): MediaInputSummary => {
    const r = fields(entry, [
      "projectId",
      "mediaInputId",
      "latestInputRevision",
      "item",
      "workflowId",
      "createdAt",
    ]);
    const mediaInputId = id(r.mediaInputId),
      projectId = id(r.projectId);
    if (
      projectId !== q.projectId ||
      (previous !== null && compare(previous, mediaInputId) >= 0)
    )
      invalid();
    previous = mediaInputId;
    let item: MediaInputItem;
    if (r.workflowId === "krea2-reference-four-view") {
      const i = fields(r.item, ["kind", "assetId"]);
      if (i.kind !== "character-reference") invalid();
      item = Object.freeze({ kind: i.kind, assetId: id(i.assetId) });
    } else if (r.workflowId === "flux2-three-reference-storyboard") {
      const i = fields(r.item, ["kind", "episodeId"]);
      if (i.kind !== "storyboard-frame-exploration") invalid();
      item = Object.freeze({ kind: i.kind, episodeId: id(i.episodeId) });
    } else invalid();
    return Object.freeze({
      projectId,
      mediaInputId,
      latestInputRevision: revision(r.latestInputRevision),
      item,
      workflowId: r.workflowId,
      createdAt: timestamp(r.createdAt),
    });
  });
  const nextMediaInputId =
    f.nextMediaInputId === null ? null : id(f.nextMediaInputId);
  if (
    nextMediaInputId !== null &&
    (inputs.length !== q.limit ||
      nextMediaInputId !== inputs.at(-1)?.mediaInputId)
  )
    invalid();
  return Object.freeze({ inputs: Object.freeze(inputs), nextMediaInputId });
}
function compare(a: string, b: string) {
  const aa = [...a],
    bb = [...b];
  for (let n = 0; n < Math.min(aa.length, bb.length); n++) {
    const difference = aa[n]!.codePointAt(0)! - bb[n]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return aa.length - bb.length;
}
function invalid(): never {
  throw new ContractValidationError("project_media_input_catalog_invalid");
}
