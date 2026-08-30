import type { ModelTransportEvent } from "@crewon/agent-kernel";
import type { ProviderCheckpoint } from "@crewon/contracts";

import { protocolError } from "./responses-errors.ts";
import { ResponsesProtocolDecoder } from "./responses-protocol.ts";

/** Rebuilds the stream invariants from one bounded retrieved Responses object. */
export function projectRetrievedResponse(
  value: unknown,
  expectedId: string,
  checkpoint: ProviderCheckpoint,
): Readonly<{
  status: "pending" | "terminal";
  events: readonly ModelTransportEvent[];
}> {
  const response = object(value);
  if (response.id !== expectedId) {
    throw protocolError("responses_response_id_mismatch");
  }
  if (response.status === "queued" || response.status === "in_progress") {
    return { status: "pending", events: [] };
  }
  if (
    response.status !== "completed" &&
    response.status !== "failed" &&
    response.status !== "incomplete"
  ) {
    throw protocolError("responses_retrieve_status_invalid");
  }
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "whenPresent",
    completedCheckpoint: () => checkpoint,
    createdCheckpoint: () => checkpoint,
  });
  const events = [...decoder.accept({ type: "response.created", response })];
  if (response.status === "completed") {
    if (!Array.isArray(response.output)) {
      throw protocolError("responses_output_invalid");
    }
    for (const rawItem of response.output) {
      const item = object(rawItem);
      if (item.type === "message") {
        if (!Array.isArray(item.content)) {
          throw protocolError("responses_output_message_invalid");
        }
        for (const rawPart of item.content) {
          const part = object(rawPart);
          if (part.type !== "output_text" || typeof part.text !== "string") {
            throw protocolError("responses_output_message_invalid");
          }
          events.push(
            ...decoder.accept({
              type: "response.output_text.delta",
              delta: part.text,
            }),
          );
        }
      }
      events.push(
        ...decoder.accept({ type: "response.output_item.done", item }),
      );
    }
  }
  events.push(
    ...decoder.accept({ type: `response.${response.status}`, response }),
  );
  return { status: "terminal", events };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError("responses_retrieve_response_invalid");
  }
  return value as Record<string, unknown>;
}
