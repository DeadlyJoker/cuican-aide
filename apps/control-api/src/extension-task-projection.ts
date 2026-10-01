import {
  ApplicationError,
  type ExtensionReadApplicationService,
} from "@crewon/application";
import type { GetExtensionTaskResponse } from "@crewon/contracts";

type Task = Awaited<ReturnType<ExtensionReadApplicationService["getTask"]>>;

/** Reviewed provider references only. Model text and provider operation IDs confer no result authority. */
export function projectExtensionTask(value: Task): GetExtensionTaskResponse {
  let truncated = value.truncated;
  let remainingImageBytes = 64 * 1024;
  const operations = value.operations.map((operation) => {
    const images: { url: string; filename: string }[] = [];
    if (
      operation.status === "succeeded" &&
      value.binding.pluginId === "crewon.comfyui-krea2"
    ) {
      if (
        operation.resultJson === null ||
        Buffer.byteLength(operation.resultJson) > 16_384
      )
        invalid();
      const result = record(JSON.parse(operation.resultJson!), ["images"]);
      if (!Array.isArray(result.images) || result.images.length > 16) invalid();
      const baseUrl = serviceUrl(value.configuration.parameters.baseUrl);
      for (const entry of result.images as unknown[]) {
        const image = record(entry, ["filename", "subfolder", "type", "url"]);
        if (
          typeof image.filename !== "string" ||
          !image.filename ||
          image.filename.length > 255 ||
          /[\\/\u0000-\u001f\u007f]/u.test(image.filename) ||
          image.filename === "." ||
          image.filename === ".." ||
          typeof image.subfolder !== "string" ||
          image.subfolder.length > 512 ||
          /[\\\u0000-\u001f\u007f]/u.test(image.subfolder) ||
          image.subfolder.startsWith("/") ||
          image.subfolder
            .split("/")
            .some((part) => part === "." || part === "..") ||
          image.type !== "output"
        )
          invalid();
        const expected = new URL(
          `/view?${new URLSearchParams({ filename: image.filename as string, subfolder: image.subfolder as string, type: "output" })}`,
          baseUrl,
        ).href;
        if (image.url !== expected || Buffer.byteLength(expected) > 2048)
          invalid();
        const projected = { url: expected, filename: image.filename as string };
        const bytes = Buffer.byteLength(JSON.stringify(projected));
        if (bytes > remainingImageBytes) truncated = true;
        else {
          remainingImageBytes -= bytes;
          images.push(projected);
        }
      }
    }
    return {
      operationId: operation.operationId,
      sourceRunId: operation.runId,
      status: operation.status,
      observedAt: operation.updatedAt,
      images,
    };
  });
  return {
    task: {
      runId: value.run.runId,
      threadId: value.run.threadId,
      pluginId: value.binding.pluginId,
      pluginVersion: value.configuration.pluginVersion,
      configurationRevision: value.binding.configurationRevision,
      runStatus: value.run.status,
      sourceRunId: value.binding.source?.runId ?? null,
      operations,
      truncated,
    },
  };
}

function serviceUrl(input: unknown): URL {
  if (typeof input !== "string") invalid();
  let url: URL;
  try {
    url = new URL(input as string);
  } catch {
    invalid();
  }
  if (
    url!.protocol !== "https:" ||
    url!.username ||
    url!.password ||
    url!.search ||
    url!.hash ||
    url!.pathname !== "/"
  )
    invalid();
  return url!;
}
function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !== [...keys].sort().join("\0")
  )
    invalid();
  return input as Record<string, unknown>;
}
function invalid(): never {
  throw new ApplicationError("internal", "extension_result_invalid");
}
