import {
  MODEL_HTTP_STREAM_EVENT_TYPES,
  type ModelHttpStreamEventType,
} from "@crewon/agent-kernel";
import type { ResponsesStreamDiagnostics } from "./responses-stream-diagnostics.ts";

type Inspection = Parameters<
  ResponsesStreamDiagnostics["pendingInspection"]
>[0];
/** End-of-read classification only. It never dispatches or accepts a buffered event. */
export function inspectPendingResponsesFrame(buffer: string): Inspection {
  if (buffer.length === 0) return { pendingJsonState: "empty" };
  if (
    buffer.length > 256 * 1024 ||
    new TextEncoder().encode(buffer).byteLength > 256 * 1024
  )
    return { pendingJsonState: "not-complete-json" };
  const groups: string[][] = [];
  let lines: string[] = [];
  for (const line of buffer.split(/\r\n|\r|\n/)) {
    if (line.length === 0) {
      if (lines.length) {
        groups.push(lines);
        lines = [];
        if (groups.length > 1)
          return { pendingJsonState: "multiple-data-events" };
      }
      continue;
    }
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
  }
  if (lines.length) groups.push(lines);
  if (groups.length > 1) return { pendingJsonState: "multiple-data-events" };
  if (groups.length === 0) return { pendingJsonState: "no-data" };
  const data = groups[0]!.join("\n");
  if (data === "[DONE]") return { pendingJsonState: "done-marker" };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { pendingJsonState: "not-complete-json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { pendingJsonState: "complete-nonobject" };
  const type = (value as Record<string, unknown>).type;
  return {
    pendingJsonState: "complete-object",
    pendingEventType: (
      MODEL_HTTP_STREAM_EVENT_TYPES as readonly unknown[]
    ).includes(type)
      ? (type as ModelHttpStreamEventType)
      : "unknown",
  };
}
