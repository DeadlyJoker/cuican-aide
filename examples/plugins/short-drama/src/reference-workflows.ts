import { types } from "node:util";
import t10 from "./templates/krea2-reference-four-view.api.json" with { type: "json" };
import d18 from "./templates/flux2-three-reference-storyboard.api.json" with { type: "json" };
import {
  renderComfyApiGraph,
  validateComfyApiGraph,
  type ComfyApiGraph,
  type ComfyApiGraphOptions,
} from "../build-support/comfyui-api-workflow-validation.mjs";
import { canonical, sha256, promptId } from "./catalog.js";
import { imageReference, type ImageReference } from "./protocol.js";
import { observeJob, type Observation } from "./protocol.js";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";

export type ReferenceWorkflowId =
  | "krea2-reference-four-view"
  | "flux2-three-reference-storyboard";
export type ReferenceImageRole =
  | "character"
  | "scene"
  | "characterOne"
  | "characterTwo";
export type ReferenceWorkflowRequest = Readonly<{
  workflowId: ReferenceWorkflowId;
  prompt: string;
  operationId: string;
  sourceServiceOrigin: string;
  targetServiceOrigin: string;
  images: Readonly<Partial<Record<ReferenceImageRole, ImageReference>>>;
}>;
export type RenderedReferenceWorkflow = Readonly<{
  workflowId: ReferenceWorkflowId;
  workflowDigest: string;
  outputNodeId: string;
  graph: ComfyApiGraph;
  sourceImages: Readonly<Partial<Record<ReferenceImageRole, ImageReference>>>;
}>;

const fourViewOptions: ComfyApiGraphOptions = Object.freeze({
  outputNodeId: "129",
  prompt: Object.freeze({ nodeId: "143", input: "prompt" }),
  outputPrefix: Object.freeze({ nodeId: "129", input: "filename_prefix" }),
});
const storyboardOptions: ComfyApiGraphOptions = Object.freeze({
  outputNodeId: "17",
  prompt: Object.freeze({ nodeId: "235:231", input: "text" }),
  outputPrefix: Object.freeze({ nodeId: "17", input: "filename_prefix" }),
});
const templates = Object.freeze({
  "krea2-reference-four-view": Object.freeze({
    graph: validateComfyApiGraph(t10, fourViewOptions),
    options: fourViewOptions,
    slots: Object.freeze({ character: Object.freeze(["146"]) }),
  }),
  "flux2-three-reference-storyboard": Object.freeze({
    graph: validateComfyApiGraph(d18, storyboardOptions),
    options: storyboardOptions,
    // Disabled nodes still inherit IS_CHANGED and must have a valid file.
    slots: Object.freeze({
      scene: Object.freeze(["240", "277", "548"]),
      characterOne: Object.freeze(["278"]),
      characterTwo: Object.freeze(["279"]),
    }),
  }),
});

/** Descriptive adapter metadata only; this does not publish or grant an executable stage. */
export const referenceWorkflowCatalog = Object.freeze(
  Object.entries(templates).map(([workflowId, template]) =>
    Object.freeze({
      workflowId: workflowId as ReferenceWorkflowId,
      workflowDigest: sha256(canonical(template.graph)),
      outputNodeId: template.options.outputNodeId,
      imageRoles: Object.freeze(
        Object.keys(template.slots) as ReferenceImageRole[],
      ),
      outputKind: "image" as const,
      preparation: "verified-same-service-output" as const,
    }),
  ),
);

function fields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input))
    throw new Error("short_drama_reference_input_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("short_drama_reference_input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some(
      (key) =>
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key], "value"),
    )
  )
    throw new Error("short_drama_reference_input_invalid");
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function serviceOrigin(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048)
    throw new Error("short_drama_reference_origin_invalid");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("short_drama_reference_origin_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("short_drama_reference_origin_invalid");
  return url.origin;
}
/** Files are resolved by the host from verified selected results, never model-supplied paths. */
function outputInput(
  input: unknown,
): Readonly<{ reference: ImageReference; value: string }> {
  const value = fields(input, ["filename", "subfolder", "type"]);
  const reference = imageReference(value);
  if (
    /[\[\]:\ud800-\udfff]/u.test(reference.filename + reference.subfolder) ||
    reference.subfolder
      .split("/")
      .some((part) => !part && reference.subfolder !== "") ||
    reference.filename.trim() !== reference.filename ||
    reference.subfolder.trim() !== reference.subfolder
  )
    throw new Error("short_drama_reference_path_invalid");
  const path = [reference.subfolder, reference.filename]
    .filter(Boolean)
    .join("/");
  return Object.freeze({ reference, value: `${path} [output]` });
}

/**
 * Pure rendering after host material preparation. DTOs are not authorization or
 * a file-read proof: the caller must freeze project/reference revisions, prove
 * bytes and current authority, and reserve the original operation before IO.
 */
export function renderReferenceWorkflow(
  input: ReferenceWorkflowRequest,
): RenderedReferenceWorkflow {
  const request = fields(input, [
    "workflowId",
    "prompt",
    "operationId",
    "sourceServiceOrigin",
    "targetServiceOrigin",
    "images",
  ]);
  const workflowId = request.workflowId;
  if (
    workflowId !== "krea2-reference-four-view" &&
    workflowId !== "flux2-three-reference-storyboard"
  )
    throw new Error("short_drama_reference_workflow_invalid");
  if (
    serviceOrigin(request.sourceServiceOrigin) !==
    serviceOrigin(request.targetServiceOrigin)
  )
    throw new Error("short_drama_reference_transfer_required");
  const template = templates[workflowId];
  const roles = Object.keys(template.slots) as ReferenceImageRole[];
  const images = fields(request.images, roles);
  const graph = structuredClone(
    renderComfyApiGraph(template.graph, template.options, {
      prompt: request.prompt as string,
      outputPrefix: `crewon-${promptId(request.operationId)}`,
    }),
  ) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const sources: Partial<Record<ReferenceImageRole, ImageReference>> = {};
  for (const role of roles) {
    const prepared = outputInput(images[role]);
    sources[role] = prepared.reference;
    const slots = template.slots as Readonly<
      Partial<Record<ReferenceImageRole, readonly string[]>>
    >;
    for (const nodeId of slots[role]!)
      graph[nodeId]!.inputs.image = prepared.value;
  }
  return Object.freeze({
    workflowId,
    workflowDigest: sha256(canonical(template.graph)),
    outputNodeId: template.options.outputNodeId,
    graph: validateComfyApiGraph(graph, template.options),
    sourceImages: Object.freeze(sources),
  });
}

/** Select the reviewed output node, never whichever image output happens to be first. */
export function observeReferenceWorkflow(
  workflowId: ReferenceWorkflowId,
  operationId: string,
  read: (path: string) => Promise<PluginJsonValue>,
): Promise<Observation> {
  if (
    workflowId !== "krea2-reference-four-view" &&
    workflowId !== "flux2-three-reference-storyboard"
  )
    throw new Error("short_drama_reference_workflow_invalid");
  return observeJob(operationId, read, {
    outputNodeId: templates[workflowId].options.outputNodeId as "129" | "17",
  });
}
