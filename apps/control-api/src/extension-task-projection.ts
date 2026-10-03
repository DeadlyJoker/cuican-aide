import type { ExtensionReadApplicationService } from "@crewon/application";
import type { GetExtensionTaskResponse } from "@crewon/contracts";
import { verifiedExtensionTaskImages } from "./extension-task-result-projection.ts";

type Task = Awaited<ReturnType<ExtensionReadApplicationService["getTask"]>>;

/** Reviewed provider references only. Model text and provider operation IDs confer no result authority. */
export function projectExtensionTask(value: Task): GetExtensionTaskResponse {
  let truncated = value.truncated;
  let remainingImageBytes = 64 * 1024;
  const operations = value.operations.map((operation) => {
    const images: { url: string; filename: string }[] = [];
    for (const image of verifiedExtensionTaskImages(value, operation)) {
      const projected = { url: image.url, filename: image.filename };
      const bytes = Buffer.byteLength(JSON.stringify(projected));
      if (bytes > remainingImageBytes) truncated = true;
      else {
        remainingImageBytes -= bytes;
        images.push(projected);
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
