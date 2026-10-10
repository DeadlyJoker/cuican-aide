import type { ControlApiClient } from "@crewon/control-client";
import type {
  GetThreadTranscriptWindowResponse,
  MessageView,
} from "@crewon/contracts";
import { waitForControlTranscriptRead } from "./controlTranscriptReads";

type CanonicalOutputClient = Pick<
  ControlApiClient,
  "getThreadTranscriptWindow" | "getThread"
>;
const MAX_CANONICAL_OUTPUT_PAGES = 4;

/** Find one durable output without changing the user's transcript position. */
export async function readControlRunCanonicalOutput(
  input: Readonly<{
    client: CanonicalOutputClient;
    threadId: string;
    runId: string;
    outputId: string;
    threadRevision: number;
    signal: AbortSignal;
  }>,
): Promise<MessageView> {
  let cursor: string | null = null;
  let upperSequence = Infinity;
  let headMessageSequence: number | undefined;
  for (let pageIndex = 0; pageIndex < MAX_CANONICAL_OUTPUT_PAGES; pageIndex++) {
    input.signal.throwIfAborted();
    const page: GetThreadTranscriptWindowResponse =
      await waitForControlTranscriptRead(
        input.client.getThreadTranscriptWindow(
          input.threadId,
          { cursor, limit: 100 },
          { signal: input.signal },
        ),
        input.signal,
      );
    input.signal.throwIfAborted();
    const window = page.messageWindow;
    if (window.threadId !== input.threadId)
      throw new Error("control_run_canonical_thread_invalid");
    if (
      window.threadRevision !== input.threadRevision ||
      window.eventSequence !== input.threadRevision ||
      (headMessageSequence !== undefined &&
        window.headMessageSequence !== headMessageSequence)
    )
      throw new Error("control_thread_projection_snapshot_changed");
    headMessageSequence = window.headMessageSequence;
    if (page.runBindings.length !== window.data.length)
      throw new Error("control_run_canonical_output_window_invalid");
    let previousSequence = 0;
    let output: MessageView | undefined;
    for (const [index, message] of window.data.entries()) {
      const binding = page.runBindings[index];
      if (
        message.threadId !== input.threadId ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= previousSequence ||
        message.sequence >= upperSequence ||
        message.sequence > window.headMessageSequence ||
        binding?.messageId !== message.messageId
      )
        throw new Error("control_run_canonical_output_window_invalid");
      previousSequence = message.sequence;
      if (message.messageId !== input.outputId) continue;
      if (
        message.role !== "assistant" ||
        binding.runId !== input.runId ||
        binding.source !== "messageCompletedEvent"
      )
        throw new Error("control_run_canonical_output_not_observed");
      output = message;
    }
    if (output !== undefined) {
      const snapshot = await waitForControlTranscriptRead(
        input.client.getThread(input.threadId, { signal: input.signal }),
        input.signal,
      );
      input.signal.throwIfAborted();
      if (snapshot.thread.threadId !== input.threadId)
        throw new Error("control_run_canonical_thread_invalid");
      if (
        snapshot.thread.revision !== input.threadRevision ||
        snapshot.eventSequence !== window.eventSequence
      )
        throw new Error("control_thread_projection_snapshot_changed");
      return output;
    }
    if (window.olderCursor === null || window.data.length === 0)
      throw new Error("control_run_canonical_output_not_observed");
    // Strictly descending positive sequences rule out replayed/cyclic pages;
    // no message history or visited-cursor collection is retained.
    upperSequence = window.data[0]!.sequence;
    cursor = window.olderCursor;
  }
  throw new Error("control_run_canonical_output_not_observed");
}
