import {
  ApplicationError,
  type ProjectGenerationReadApplicationService,
} from "@crewon/application";
import {
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  parseGetConceptGenerationResponse,
  type GetConceptGenerationResponse,
} from "@crewon/contracts";
import { verifiedExtensionTaskImages } from "./extension-task-result-projection.ts";

type Generation = Awaited<
  ReturnType<ProjectGenerationReadApplicationService["getConceptGeneration"]>
>;
type PublicGeneration = NonNullable<GetConceptGenerationResponse["generation"]>;
type MutableOperation = Omit<
  PublicGeneration["task"]["operations"][number],
  "images"
> & {
  images: { url: string; filename: string; resultIndex: number }[];
};
type MutableTask = Omit<
  PublicGeneration["task"],
  "operations" | "truncated"
> & {
  operations: MutableOperation[];
  truncated: boolean;
};
type MutableGeneration = Omit<PublicGeneration, "task"> & { task: MutableTask };

/** No provider calls: only the original authorized Run and its verified persisted observations. */
export function projectConceptGeneration(
  value: Generation,
): GetConceptGenerationResponse {
  if (value === null) return { generation: null };
  const { link, task } = value;
  if (task.binding.source !== null)
    throw new ApplicationError("internal", "project_generation_link_invalid");
  const generation: MutableGeneration = {
    projectId: link.reference.projectId,
    assetId: link.reference.assetId,
    assetRevision: link.reference.assetRevision,
    briefRevision: link.briefRevision,
    createdAt: link.createdAt,
    task: {
      runId: task.run.runId,
      threadId: task.run.threadId,
      pluginId: task.binding.pluginId,
      pluginVersion: task.configuration.pluginVersion,
      configurationRevision: task.binding.configurationRevision,
      runStatus: task.run.status,
      sourceRunId: null,
      operations: task.operations.map((operation) => ({
        operationId: operation.operationId,
        sourceRunId: operation.runId,
        status: operation.status,
        observedAt: operation.updatedAt,
        operationRevision: operation.revision,
        images: [],
      })),
      truncated: task.truncated,
    },
  };
  const response = { generation };
  assertBudget(response);
  for (let position = 0; position < task.operations.length; position++) {
    const operation = task.operations[position]!;
    const images = generation.task.operations[position]!.images;
    for (const image of verifiedExtensionTaskImages(task, operation)) {
      images.push({
        url: image.url,
        filename: image.filename,
        resultIndex: image.resultIndex,
      });
      if (responseBytes(response) > MAX_CREATIVE_PROJECT_RESPONSE_BYTES) {
        images.pop();
        generation.task.truncated = true;
      }
    }
  }
  assertBudget(response);
  return parseGetConceptGenerationResponse(response, {
    projectId: link.reference.projectId,
    assetId: link.reference.assetId,
    assetRevision: link.reference.assetRevision,
  });
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertBudget(value: unknown): void {
  if (responseBytes(value) > MAX_CREATIVE_PROJECT_RESPONSE_BYTES)
    throw new ApplicationError("internal", "creative_project_response_limit");
}
