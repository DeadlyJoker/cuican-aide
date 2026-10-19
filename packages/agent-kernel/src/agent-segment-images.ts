import { types } from "node:util";
import {
  AgentKernelError,
  type AgentSegmentContract,
  type AgentSegmentRunOptions,
} from "./agent-kernel-port.ts";
import { validateModelImageObservations } from "./model-image-observation.ts";
import type { ModelRequest } from "./model-transport-port.ts";

/** Review-only augmentation. Existing history is untouched and images append once. */
export function appendSegmentImageObservations(
  contract: AgentSegmentContract,
  input: ModelRequest["input"],
  toolCount: number,
  options: AgentSegmentRunOptions | undefined,
): ModelRequest["input"] {
  const images = options?.imageObservations;
  if (images === undefined) return input;
  if (
    contract.purpose !== "agent" ||
    toolCount !== 0 ||
    contract.reconcileCheckpoint !== undefined ||
    options?.emptyResponseContinuation === "durableBoundary" ||
    contract.history.some((item) => item.type !== "message") ||
    !Array.isArray(images) ||
    types.isProxy(images) ||
    images.length === 0
  )
    throw new AgentKernelError("segment_image_review_scope_invalid", false);
  try {
    const snapshot = validateModelImageObservations(images, contract);
    return { ...input, items: [...input.items, ...snapshot] };
  } catch (cause) {
    throw new AgentKernelError("segment_image_input_invalid", false, { cause });
  }
}
