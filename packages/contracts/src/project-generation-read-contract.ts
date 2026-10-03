import type { components } from "./generated/control-api.ts";
import { parseGetExtensionTaskResponse } from "./extension-read-contract.ts";
import {
  creativeControlArray,
  creativeControlCopy,
  creativeControlFailure,
  creativeControlId,
  creativeControlRecord,
  creativeControlRevision,
  creativeControlTimestamp,
} from "./creative-project-control-support.ts";

export type ConceptGenerationLocator = Readonly<{
  projectId: string;
  assetId: string;
  assetRevision: number;
}>;
export type ConceptGenerationImage = Readonly<
  components["schemas"]["ConceptGenerationImage"]
>;
export type ConceptGenerationOperation = Readonly<
  Omit<components["schemas"]["ConceptGenerationOperation"], "images"> & {
    images: readonly ConceptGenerationImage[];
  }
>;
export type ConceptGenerationTaskView = Readonly<
  Omit<components["schemas"]["ConceptGenerationTaskView"], "operations"> & {
    operations: readonly ConceptGenerationOperation[];
  }
>;
export type PublicConceptGeneration = Readonly<
  Omit<components["schemas"]["PublicConceptGeneration"], "task"> & {
    task: ConceptGenerationTaskView;
  }
>;
export type GetConceptGenerationResponse = Readonly<{
  generation: PublicConceptGeneration | null;
}>;

const TASK_FIELDS = [
  "runId",
  "threadId",
  "pluginId",
  "pluginVersion",
  "configurationRevision",
  "runStatus",
  "sourceRunId",
  "operations",
  "truncated",
] as const;

/** The public locator cannot select an execution plugin, account or Run. */
export function parseConceptGenerationLocator(
  input: unknown,
): ConceptGenerationLocator {
  const value = creativeControlRecord(creativeControlCopy(input), [
    "projectId",
    "assetId",
    "assetRevision",
  ]);
  return Object.freeze({
    projectId: creativeControlId(value.projectId),
    assetId: creativeControlId(value.assetId),
    assetRevision: creativeControlRevision(value.assetRevision),
  });
}

/** Bounded original-task projection; it does not grant result-selection authority. */
export function parseGetConceptGenerationResponse(
  input: unknown,
  expected?: ConceptGenerationLocator,
): GetConceptGenerationResponse {
  const locator =
    expected === undefined
      ? undefined
      : parseConceptGenerationLocator(expected);
  const envelope = creativeControlRecord(creativeControlCopy(input), [
    "generation",
  ]);
  if (envelope.generation === null) return Object.freeze({ generation: null });
  const generation = creativeControlRecord(envelope.generation, [
    "projectId",
    "assetId",
    "assetRevision",
    "briefRevision",
    "createdAt",
    "task",
  ]);
  const source = parseConceptGenerationLocator({
    projectId: generation.projectId,
    assetId: generation.assetId,
    assetRevision: generation.assetRevision,
  });
  if (
    locator !== undefined &&
    (source.projectId !== locator.projectId ||
      source.assetId !== locator.assetId ||
      source.assetRevision !== locator.assetRevision)
  )
    creativeControlFailure();
  const task = creativeControlRecord(generation.task, TASK_FIELDS);
  if (task.sourceRunId !== null) creativeControlFailure();
  let omittedEarlierImage = false;
  const operations = creativeControlArray(task.operations, 16).map((raw) => {
    const operation = creativeControlRecord(raw, [
      "operationId",
      "sourceRunId",
      "status",
      "observedAt",
      "images",
      "operationRevision",
    ]);
    const operationRevision = creativeControlRevision(
      operation.operationRevision,
    );
    let priorIndex = -1;
    const images = creativeControlArray(operation.images, 16).map(
      (rawImage) => {
        const image = creativeControlRecord(rawImage, [
          "url",
          "filename",
          "resultIndex",
        ]);
        const resultIndex = creativeControlRevision(image.resultIndex, 0);
        if (resultIndex > 15 || resultIndex <= priorIndex)
          creativeControlFailure();
        if (resultIndex !== priorIndex + 1) omittedEarlierImage = true;
        priorIndex = resultIndex;
        return { url: image.url, filename: image.filename, resultIndex };
      },
    );
    if (operation.status !== "succeeded" && images.length !== 0)
      creativeControlFailure();
    return { operation, operationRevision, images };
  });
  // Keep the existing strict task parser unchanged, while reusing its identity,
  // URL, operation-status and duplicate-ID validation for the original fields.
  const checked = parseGetExtensionTaskResponse({
    task: {
      ...task,
      operations: operations.map(({ operation, images }) => ({
        operationId: operation.operationId,
        sourceRunId: operation.sourceRunId,
        status: operation.status,
        observedAt: operation.observedAt,
        images: images.map(({ url, filename }) => ({ url, filename })),
      })),
    },
  });
  if (omittedEarlierImage && !checked.task.truncated) creativeControlFailure();
  return freeze({
    generation: {
      ...source,
      briefRevision: creativeControlRevision(generation.briefRevision),
      createdAt: creativeControlTimestamp(generation.createdAt),
      task: {
        ...checked.task,
        sourceRunId: null,
        operations: checked.task.operations.map((operation, index) => ({
          ...operation,
          operationRevision: operations[index]!.operationRevision,
          images: operation.images.map((image, imageIndex) => ({
            ...image,
            resultIndex: operations[index]!.images[imageIndex]!.resultIndex,
          })),
        })),
      },
    },
  });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
