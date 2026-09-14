import {
  parseModelImageGeneratedData,
  parseModelImageProgressData,
} from "@crewon/contracts";
import { AgentKernelError } from "./agent-kernel-port.ts";
import type { ModelTransportEvent } from "./model-transport-port.ts";

type ImageEvent = Extract<
  ModelTransportEvent,
  { type: "image.progress" | "image.generated" }
>;

/** A segment's image metadata survives sampling retries without duplicating artifacts. */
export class ModelImageOutput {
  readonly #items = new Map<
    string,
    { stage: number; generated: string | null }
  >();

  observe(event: ImageEvent): ImageEvent | null {
    const { type, ...metadata } = event;
    let data;
    try {
      data =
        type === "image.progress"
          ? parseModelImageProgressData(metadata)
          : parseModelImageGeneratedData(metadata);
    } catch (cause) {
      throw new AgentKernelError("model_image_metadata_invalid", false, {
        cause,
      });
    }
    let observed = this.#items.get(data.itemId);
    if (!observed) {
      if (this.#items.size >= 16)
        throw new AgentKernelError("model_image_output_limit", false);
      observed = { stage: -1, generated: null };
      this.#items.set(data.itemId, observed);
    }
    if (type === "image.progress") {
      const progress = parseModelImageProgressData(data);
      const stage = ["in_progress", "generating", "completed"].indexOf(
        progress.stage,
      );
      if (stage <= observed.stage) return null;
      observed.stage = stage;
      return { type, ...progress };
    }
    const generated = parseModelImageGeneratedData(data);
    const fingerprint = JSON.stringify(generated);
    if (observed.generated === fingerprint) return null;
    if (observed.generated !== null)
      throw new AgentKernelError("model_image_output_conflict", false);
    observed.generated = fingerprint;
    return { type, ...generated };
  }
}
