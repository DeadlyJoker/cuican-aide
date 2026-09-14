import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ModelTransportEvent } from "@crewon/agent-kernel";
import { protocolError } from "./responses-errors.ts";

export const MAX_RESPONSES_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSES_IMAGES = 4;
// A terminal response can replay all four base64 results plus bounded metadata.
export const MAX_RESPONSES_IMAGE_EVENT_BYTES = 48 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;

export type ResponsesImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export type ResponsesImageResult = Readonly<{
  itemId: string;
  mimeType: ResponsesImageMimeType;
  bytes: Uint8Array;
}>;
export interface ResponsesImageSink {
  persist(
    input: ResponsesImageResult &
      Readonly<{ runId: string; segmentId: string }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ artifactRef: string }>>;
}

export function responsesImagePersistence(
  options: Readonly<{
    sink: ResponsesImageSink | undefined;
    runId: string;
    segmentId: string;
    signal: AbortSignal;
  }>,
):
  | ((
      image: ResponsesImageResult,
    ) => Promise<Extract<ModelTransportEvent, { type: "image.generated" }>>)
  | undefined {
  const sink = options.sink;
  if (sink === undefined) return undefined;
  return async (image) => {
    const saved = await sink.persist(
      { ...image, runId: options.runId, segmentId: options.segmentId },
      options.signal,
    );
    return {
      type: "image.generated",
      itemId: image.itemId,
      artifactRef: validateResponsesImageArtifactRef(saved.artifactRef),
      mimeType: image.mimeType,
      byteLength: image.bytes.byteLength,
    };
  };
}

type ImageState = {
  outputIndex: number;
  stage: "in_progress" | "generating" | "completed";
  digest: string | null;
};

/** Tracks provider identity and replay; never puts image bytes in model history. */
export class ResponsesImageOutput {
  readonly #enabled: boolean;
  readonly #items = new Map<string, ImageState>();
  #pending: ResponsesImageResult[] = [];

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  added(
    event: Readonly<Record<string, unknown>>,
  ): readonly ModelTransportEvent[] {
    this.#requireSink();
    const item = object(event.item);
    const itemId = identity(item.id);
    const outputIndex = index(event.output_index);
    if (
      this.#items.has(itemId) ||
      [...this.#items.values()].some(
        (state) => state.outputIndex === outputIndex,
      )
    ) {
      throw protocolError("responses_image_item_duplicate");
    }
    if (this.#items.size >= MAX_RESPONSES_IMAGES) {
      throw protocolError("responses_image_count_exceeded");
    }
    if (item.status !== "in_progress")
      throw protocolError("responses_image_status_invalid");
    this.#items.set(itemId, {
      outputIndex,
      stage: "in_progress",
      digest: null,
    });
    return [{ type: "image.progress", itemId, stage: "in_progress" }];
  }

  progress(
    event: Readonly<Record<string, unknown>>,
    stage: ImageState["stage"],
  ): readonly ModelTransportEvent[] {
    this.#requireSink();
    const itemId = identity(event.item_id);
    const state = this.#state(itemId, event.output_index);
    const ranks = { in_progress: 0, generating: 1, completed: 2 };
    if (ranks[stage] < ranks[state.stage])
      throw protocolError("responses_image_progress_invalid");
    if (stage === state.stage) return [];
    state.stage = stage;
    return [{ type: "image.progress", itemId, stage }];
  }

  done(item: Readonly<Record<string, unknown>>, outputIndex: unknown): void {
    this.#requireSink();
    const itemId = identity(item.id);
    const state = this.#state(itemId, outputIndex);
    if (item.status !== "completed")
      throw protocolError("responses_image_status_invalid");
    const result = decodeImage(itemId, item);
    const digest = createHash("sha256").update(result.bytes).digest("hex");
    if (state.digest !== null) {
      if (digest !== state.digest)
        throw protocolError("responses_image_replay_mismatch");
      return;
    }
    state.digest = digest;
    state.stage = "completed";
    this.#pending.push(result);
  }

  completed(output: unknown): void {
    if (Array.isArray(output)) {
      const replayed = new Set<string>();
      for (const [outputIndex, item] of output.entries()) {
        if (!isObject(item) || item.type !== "image_generation_call") continue;
        const itemId = identity(item.id);
        if (replayed.has(itemId))
          throw protocolError("responses_image_item_duplicate");
        replayed.add(itemId);
        this.done(item, outputIndex);
      }
      if (
        output.length > 0 &&
        [...this.#items.keys()].some((id) => !replayed.has(id))
      ) {
        throw protocolError("responses_image_final_output_mismatch");
      }
    }
    if ([...this.#items.values()].some((state) => state.digest === null)) {
      throw protocolError("responses_image_result_missing");
    }
  }

  takeResults(): readonly ResponsesImageResult[] {
    const pending = this.#pending;
    this.#pending = [];
    return pending;
  }

  #state(itemId: string, outputIndex: unknown): ImageState {
    const state = this.#items.get(itemId);
    if (state === undefined || state.outputIndex !== index(outputIndex)) {
      throw protocolError("responses_image_item_mismatch");
    }
    return state;
  }

  #requireSink(): void {
    if (!this.#enabled) throw protocolError("responses_image_sink_unavailable");
  }
}

/** Only known image result fields receive the larger binary transport budget. */
export function validateResponsesImageEventSize(
  event: Readonly<Record<string, unknown>>,
): void {
  let metadata: Readonly<Record<string, unknown>> = event;
  if (
    event.type === "response.output_item.done" &&
    isObject(event.item) &&
    event.item.type === "image_generation_call"
  ) {
    metadata = { ...event, item: { ...event.item, result: null } };
  } else if (
    event.type === "response.completed" &&
    isObject(event.response) &&
    Array.isArray(event.response.output)
  ) {
    metadata = {
      ...event,
      response: {
        ...event.response,
        output: event.response.output.map((item) =>
          isObject(item) && item.type === "image_generation_call"
            ? { ...item, result: null }
            : item,
        ),
      },
    };
  }
  if (
    Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES
  ) {
    throw protocolError("responses_event_too_large");
  }
}

export function validateResponsesImageArtifactRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw protocolError("responses_image_artifact_ref_invalid");
  }
  return value;
}

function decodeImage(
  itemId: string,
  item: Readonly<Record<string, unknown>>,
): ResponsesImageResult {
  const value = item.result;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4 * Math.ceil(MAX_RESPONSES_IMAGE_BYTES / 3)
  ) {
    throw protocolError("responses_image_result_invalid");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(value) ||
    value.slice(0, value.length - padding).includes("=")
  ) {
    throw protocolError("responses_image_base64_invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength > MAX_RESPONSES_IMAGE_BYTES ||
    bytes.toString("base64") !== value
  ) {
    throw protocolError("responses_image_result_invalid");
  }
  const mimeType = imageMimeType(bytes);
  const expectedFormat = mimeType === "image/jpeg" ? "jpeg" : mimeType.slice(6);
  if (
    item.output_format !== undefined &&
    item.output_format !== expectedFormat
  ) {
    throw protocolError("responses_image_format_mismatch");
  }
  return { itemId, mimeType, bytes };
}

function imageMimeType(bytes: Uint8Array): ResponsesImageMimeType {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, offset) => bytes[offset] === value,
    )
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return "image/webp";
  throw protocolError("responses_image_format_invalid");
}

function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
    throw protocolError("responses_image_item_id_invalid");
  return value;
}

function index(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 512)
    throw protocolError("responses_image_output_index_invalid");
  return Number(value);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (!isObject(value)) throw protocolError("responses_image_item_invalid");
  return value;
}
