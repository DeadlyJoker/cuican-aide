import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import { promptId } from "./catalog.js";

export type ImageReference = Readonly<{
  filename: string;
  subfolder: string;
  type: "output";
}>;
export type Observation =
  | Readonly<{
      status: "queued" | "running" | "failed" | "unknownOutcome";
      images: readonly [];
    }>
  | Readonly<{ status: "succeeded"; images: readonly ImageReference[] }>;

export function acceptedPromptId(input: PluginJsonValue): string {
  const value = object(input);
  if (
    value.error !== undefined ||
    (value.node_errors !== undefined &&
      Object.keys(object(value.node_errors)).length > 0)
  )
    throw new Error("krea_plugin_prompt_rejected");
  return promptId(value.prompt_id);
}

/** Only these reads are needed. Missing process-local history never grants permission to POST again. */
export async function observeJob(
  id: string,
  read: (path: string) => Promise<PluginJsonValue>,
): Promise<Observation> {
  id = promptId(id);
  const history = object(await read("/history/" + id));
  if (Object.hasOwn(history, id)) {
    const record = object(history[id]);
    const status = object(record.status);
    if (status.status_str === "error") return { status: "failed", images: [] };
    if (status.completed === true && status.status_str === "success") {
      const output = object(object(record.outputs)["29"]);
      if (
        !Array.isArray(output.images) ||
        output.images.length < 1 ||
        output.images.length > 16
      )
        throw new Error("krea_plugin_images_invalid");
      return { status: "succeeded", images: output.images.map(imageReference) };
    }
  }
  const queue = object(await read("/queue"));
  for (const [key, status] of [
    ["queue_running", "running"],
    ["queue_pending", "queued"],
  ] as const) {
    const items = queue[key];
    if (!Array.isArray(items) || items.length > 10000)
      throw new Error("krea_plugin_queue_invalid");
    if (items.some((item) => Array.isArray(item) && item[1] === id))
      return { status, images: [] };
  }
  return { status: "unknownOutcome", images: [] };
}

export function imageReference(input: unknown): ImageReference {
  const value = object(input);
  if (
    typeof value.filename !== "string" ||
    !value.filename ||
    value.filename.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/u.test(value.filename) ||
    value.filename === "." ||
    value.filename === ".." ||
    typeof value.subfolder !== "string" ||
    value.subfolder.length > 512 ||
    /[\\\u0000-\u001f\u007f]/u.test(value.subfolder) ||
    value.subfolder.startsWith("/") ||
    value.subfolder.split("/").some((part) => part === "." || part === "..") ||
    value.type !== "output"
  )
    throw new Error("krea_plugin_image_reference_invalid");
  return Object.freeze({
    filename: value.filename,
    subfolder: value.subfolder,
    type: "output",
  });
}
export function imageUrl(input: ImageReference, base: string): string {
  return new URL("/view?" + new URLSearchParams(imageReference(input)), base)
    .href;
}
export function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("krea_plugin_response_invalid");
  return input as Record<string, unknown>;
}
