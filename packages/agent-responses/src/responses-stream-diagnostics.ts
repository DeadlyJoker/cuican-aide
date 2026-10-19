import {
  MODEL_HTTP_STREAM_EVENT_TYPES,
  type ModelHttpStreamEventType,
} from "@crewon/agent-kernel";
import type { ModelTransportEvent } from "@crewon/agent-kernel";

/** Numeric/classification evidence only; no stream text crosses this port. */
export type ResponsesStreamDiagnostics = Readonly<{
  chunk(bytes: number): void;
  frame(kind: "comment" | "data" | "done" | "ignored"): void;
  pending(bytes: number): void;
  pendingInspection(
    inspection: import("@crewon/agent-kernel").ModelHttpPendingInspection,
  ): void;
  event(
    type: ModelHttpStreamEventType,
    semantic: boolean,
    category?:
      | "textDeltaCount"
      | "reasoningDeltaCount"
      | "toolArgumentDeltaCount"
      | "completedItemCount"
      | "terminalEventCount",
  ): void;
}>;
export function observeResponsesStreamEvent(
  value: Readonly<Record<string, unknown>>,
  events: readonly ModelTransportEvent[],
  port: ResponsesStreamDiagnostics | undefined,
): void {
  if (!port) return;
  const type = (MODEL_HTTP_STREAM_EVENT_TYPES as readonly unknown[]).includes(
    value.type,
  )
    ? (value.type as ModelHttpStreamEventType)
    : "unknown";
  let category: Parameters<ResponsesStreamDiagnostics["event"]>[2];
  if (type === "response.output_text.delta") category = "textDeltaCount";
  else if (
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning_summary_text.delta"
  )
    category = "reasoningDeltaCount";
  else if (
    type === "response.function_call_arguments.delta" ||
    type === "response.custom_tool_call_input.delta"
  )
    category = "toolArgumentDeltaCount";
  else if (events.some((e) => e.type === "output.item.completed"))
    category = "completedItemCount";
  else if (events.some((e) => e.type === "completed" || e.type === "failed"))
    category = "terminalEventCount";
  const semantic =
    events.some(
      (e) =>
        ((e.type === "output.delta" || e.type === "reasoning.delta") &&
          e.delta.length > 0) ||
        e.type === "output.item.completed" ||
        e.type === "completed" ||
        e.type === "failed",
    ) ||
    (category === "toolArgumentDeltaCount" &&
      typeof value.delta === "string" &&
      value.delta.length > 0 &&
      new TextEncoder().encode(value.delta).byteLength <= 32 * 1024);
  port.event(type, semantic, category);
}
