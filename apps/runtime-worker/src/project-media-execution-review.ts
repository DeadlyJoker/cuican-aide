import { createHash } from "node:crypto";
import {
  parseProjectMediaWorkflowReview,
  mediaInputRoles,
  materialPreparationFields as fields,
  mediaInputData,
  type ProjectMediaRole,
  type ProjectMediaWorkflowReview,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import type { PluginJsonHttpSubmission } from "@crewon/plugin-sdk/node";
import type { ProjectMediaRenderInput } from "./project-media-run-context.ts";

/** Deployment-owned declaration of mutable graph inputs. No plugin/model DTO grants this review. */
export type ProjectMediaExecutionReview = ProjectMediaWorkflowReview &
  Readonly<{
    template: PluginJsonValue;
    promptBinding: Readonly<{ nodeId: string; input: string }>;
    imageBindings: readonly Readonly<{
      role: ProjectMediaRole;
      nodeIds: readonly string[];
    }>[];
  }>;
export function mediaExecutionFail(code: string): never {
  throw new Error(`project_media_execution_${code}`);
}
export const mediaExecutionDigest = (v: unknown) =>
  `sha256:${createHash("sha256").update(extensionCanonicalJson(v)).digest("hex")}`;
const nodeId = (v: unknown) => {
  if (typeof v !== "string" || v.length > 64 || !/^\d+(?::\d+)*$/u.test(v))
    mediaExecutionFail("review_invalid");
  return v;
};
type Graph = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, PluginJsonValue>;
    _meta?: PluginJsonValue;
  }
>;
function graph(input: unknown): Graph {
  const copy = mediaInputData(input, 65536);
  if (
    !copy ||
    typeof copy !== "object" ||
    Array.isArray(copy) ||
    !Object.keys(copy).length ||
    Object.keys(copy).length > 512
  )
    mediaExecutionFail("review_invalid");
  for (const [id, value] of Object.entries(copy)) {
    nodeId(id);
    if (!value || typeof value !== "object" || Array.isArray(value))
      mediaExecutionFail("review_invalid");
    const n = fields(value, [
      "class_type",
      "inputs",
      ...(Object.hasOwn(value, "_meta") ? ["_meta"] : []),
    ]);
    if (
      typeof n.class_type !== "string" ||
      !n.class_type.trim() ||
      n.class_type.length > 256 ||
      !n.inputs ||
      typeof n.inputs !== "object" ||
      Array.isArray(n.inputs)
    )
      mediaExecutionFail("review_invalid");
  }
  return copy as Graph;
}
export function captureProjectMediaExecutionReview(
  input: unknown,
): ProjectMediaExecutionReview {
  const r = fields(input, [
      "targetIdentity",
      "workflow",
      "template",
      "promptBinding",
      "imageBindings",
    ]),
    review = parseProjectMediaWorkflowReview({
      targetIdentity: r.targetIdentity,
      workflow: r.workflow,
    }),
    template = graph(r.template),
    p = fields(r.promptBinding, ["nodeId", "input"]),
    prompt = nodeId(p.nodeId),
    output = template[review.workflow.output.nodeId];
  if (
    typeof p.input !== "string" ||
    !/^[a-z_][a-z0-9_]{0,63}$/u.test(p.input) ||
    typeof template[prompt]?.inputs[p.input] !== "string" ||
    output?.class_type !== "SaveImage" ||
    typeof output.inputs.filename_prefix !== "string" ||
    prompt === review.workflow.output.nodeId ||
    mediaExecutionDigest(template) !== review.workflow.workflowDigest
  )
    mediaExecutionFail("review_invalid");
  const roles = mediaInputRoles(review.workflow.workflowId);
  if (
    !Array.isArray(r.imageBindings) ||
    r.imageBindings.length !== roles.length
  )
    mediaExecutionFail("review_invalid");
  const used = new Set([prompt, review.workflow.output.nodeId]);
  const imageBindings = r.imageBindings.map((value, i) => {
    const binding = fields(value, ["role", "nodeIds"]);
    if (
      binding.role !== roles[i] ||
      !Array.isArray(binding.nodeIds) ||
      !binding.nodeIds.length ||
      binding.nodeIds.length > 8
    )
      mediaExecutionFail("review_invalid");
    const nodeIds = binding.nodeIds.map((v) => {
      const id = nodeId(v);
      if (used.has(id) || typeof template[id]?.inputs.image !== "string")
        mediaExecutionFail("review_invalid");
      used.add(id);
      return id;
    });
    return Object.freeze({ role: roles[i]!, nodeIds: Object.freeze(nodeIds) });
  });
  return Object.freeze({
    ...review,
    template: freeze(template) as unknown as PluginJsonValue,
    promptBinding: Object.freeze({ nodeId: prompt, input: p.input }),
    imageBindings: Object.freeze(imageBindings),
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function imagePath(value: unknown): string {
  const r = fields(value, ["filename", "subfolder", "type"]);
  if (
    r.type !== "output" ||
    typeof r.filename !== "string" ||
    typeof r.subfolder !== "string" ||
    !r.filename ||
    r.filename.trim() !== r.filename ||
    r.subfolder.trim() !== r.subfolder ||
    /[\[\]:\\\u0000-\u001f\u007f\ud800-\udfff]/u.test(
      r.filename + r.subfolder,
    ) ||
    r.filename.includes("/") ||
    r.filename.length > 256 ||
    r.subfolder.length > 1024 ||
    (r.subfolder !== "" &&
      r.subfolder.split("/").some((p) => !p || p === "." || p === ".."))
  )
    mediaExecutionFail("material_path_invalid");
  return [r.subfolder, r.filename].filter(Boolean).join("/") + " [output]";
}
/** Pure validation oracle. The plugin still renders its own reviewed graph. */
export function expectedProjectMediaSubmission(
  review: ProjectMediaExecutionReview,
  input: ProjectMediaRenderInput,
  operationId: string,
): PluginJsonHttpSubmission {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      operationId,
    ) ||
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    input.prompt.length > 2000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) ||
    extensionCanonicalJson(input.workflow) !==
      extensionCanonicalJson(review.workflow)
  )
    mediaExecutionFail("render_input_invalid");
  const rendered = structuredClone(review.template) as Graph;
  rendered[review.promptBinding.nodeId]!.inputs[review.promptBinding.input] =
    input.prompt;
  rendered[review.workflow.output.nodeId]!.inputs.filename_prefix =
    `crewon-${operationId}`;
  const roles = mediaInputRoles(review.workflow.workflowId),
    images = fields(input.images, roles);
  for (const binding of review.imageBindings) {
    const path = imagePath(images[binding.role]);
    for (const id of binding.nodeIds) rendered[id]!.inputs.image = path;
  }
  return Object.freeze({
    method: "POST",
    path: "/prompt",
    body: {
      prompt: rendered,
      prompt_id: operationId,
      client_id: operationId,
      extra_data: { crewon_request_id: operationId },
    },
  });
}
