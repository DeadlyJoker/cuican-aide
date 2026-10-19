import {
  ModelTransportError,
  modelImageObservationInput,
  validateModelImageObservations,
  type ModelImageObservation,
  type ModelRequest,
  type ModelInputItem,
} from "@crewon/agent-kernel";

/** Only captured, tool-free review inputs are projected; never fetch an image URL. */
export function validateResponsesImageObservations(
  request: ModelRequest,
): void {
  const images = request.input.items.filter(isImageObservation);
  if (images.length === 0) return;
  if (
    request.tools.length !== 0 ||
    request.reconcileCheckpoint !== undefined ||
    request.input.items.some(
      (item) =>
        item == null ||
        (item.type !== "message" && item.type !== "image_observation"),
    )
  )
    fail("responses_image_review_scope_invalid");
  try {
    validateModelImageObservations(images, request);
  } catch (cause) {
    throw new ModelTransportError({
      category: "protocol",
      code: "responses_image_input_invalid",
      retryable: false,
      cause,
    });
  }
}

function isImageObservation(item: unknown): item is ModelImageObservation {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as Record<string, unknown>).type === "image_observation"
  );
}

type ImageLineage = Readonly<{
  runId: string;
  segmentId: string;
  agentVersionId: string;
  evidence: readonly string[];
}>;

/** Bounded response lineage contains metadata only, never captured pixels. */
export class ResponsesImageInputState {
  readonly #runs = new Map<string, Map<string, ImageLineage>>();

  capture(request: ModelRequest): ImageLineage | null {
    validateResponsesImageObservations(request);
    const evidence = request.input.items
      .filter(
        (item): item is ModelImageObservation =>
          item.type === "image_observation",
      )
      .map(imageEvidenceKey);
    return evidence.length === 0
      ? null
      : Object.freeze({
          runId: request.runId,
          segmentId: request.segmentId,
          agentVersionId: request.agentVersionId,
          evidence: Object.freeze(evidence),
        });
  }

  /** Called only after the transport has validated the terminal and received tail. */
  completed(lineage: ImageLineage | null, responseId: string): void {
    if (lineage === null) return;
    let responses = this.#runs.get(lineage.runId);
    if (responses === undefined) {
      responses = new Map();
      this.#runs.set(lineage.runId, responses);
    }
    responses.delete(responseId);
    responses.set(responseId, lineage);
    while (responses.size > 16)
      responses.delete(responses.keys().next().value!);
    while (this.#runs.size > 32)
      this.#runs.delete(this.#runs.keys().next().value!);
  }

  includesPriorEvidence(
    request: ModelRequest,
    responseId: string,
    omitted: readonly ModelImageObservation[],
  ): boolean {
    const previous = this.#runs.get(request.runId)?.get(responseId);
    if (
      previous === undefined ||
      previous.segmentId !== request.segmentId ||
      previous.agentVersionId !== request.agentVersionId
    )
      return false;
    const current = new Set(
      request.input.items
        .filter(
          (item): item is ModelImageObservation =>
            item.type === "image_observation",
        )
        .map(imageEvidenceKey),
    );
    // Retained provider context must not include removed or superseded images.
    return (
      previous.evidence.every((key) => current.has(key)) &&
      omitted.every((item) =>
        previous.evidence.includes(imageEvidenceKey(item)),
      )
    );
  }

  releaseRun(runId: string): void {
    this.#runs.delete(runId);
  }
  clear(): void {
    this.#runs.clear();
  }
}

/** A truncated input is reusable only when this transport observed its image evidence. */
export function planResponsesImageInput(
  options: Readonly<{
    request: ModelRequest;
    previousResponseId: string | null;
    inputItems: readonly ModelInputItem[];
    imageState?: ResponsesImageInputState;
  }>,
): Readonly<{
  previousResponseId: string | null;
  inputItems: readonly ModelInputItem[];
}> {
  const { request, inputItems, previousResponseId, imageState } = options;
  validateResponsesImageObservations(request);
  const all = request.input.items;
  const containsImages =
    all.some((item) => item.type === "image_observation") ||
    inputItems.some((item) => item.type === "image_observation");
  if (!containsImages) return { inputItems, previousResponseId };
  const offset = all.length - inputItems.length;
  if (
    offset < 0 ||
    !inputItems.every((item, index) => item === all[offset + index])
  )
    fail("responses_image_selection_invalid");
  const omitted = all
    .slice(0, offset)
    .filter(
      (item): item is ModelImageObservation =>
        item.type === "image_observation",
    );
  if (
    previousResponseId === null
      ? offset !== 0
      : !imageState?.includesPriorEvidence(request, previousResponseId, omitted)
  )
    return { inputItems: all, previousResponseId: null };
  return { inputItems, previousResponseId };
}

function imageEvidenceKey(item: ModelImageObservation): string {
  return JSON.stringify([
    item.evidenceId,
    item.contentDigest,
    item.mediaType,
    item.detail,
  ]);
}

export function responsesImageInputItem(
  item: ModelImageObservation,
  request: ModelRequest,
) {
  try {
    return modelImageObservationInput(item, request);
  } catch (cause) {
    throw new ModelTransportError({
      category: "protocol",
      code: "responses_image_input_invalid",
      retryable: false,
      cause,
    });
  }
}

function fail(code: string): never {
  throw new ModelTransportError({
    category: "protocol",
    code,
    retryable: false,
  });
}
