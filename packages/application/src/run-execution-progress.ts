import type { RunExecutionProgressCheckpoint } from "./run-execution-progress-store-port.ts";
import {
  parseRunProgressCheckpoint,
  type PendingToolReference,
  type SavedRunProgress,
} from "./run-execution-progress-checkpoint.ts";
import { isEmptyProviderContinuationSource } from "@crewon/domain";
import type { RunLifecycleEvent } from "@crewon/domain";

/** Folds paged execution events; never retains the complete Run transcript. */
export class RunExecutionProgress {
  readonly #runId: string;
  readonly #invalid: (code: string) => never;
  readonly #pendingToolLimit: 16 | 128;
  readonly #pending = new Map<string, PendingToolReference>();
  readonly #pendingEvents = new Map<
    string,
    Extract<RunLifecycleEvent, { type: "tool.requested" }>
  >();
  #lastEventId = "";
  #emptyContinuationSequence: number | null = null;
  readonly #segmentSequences = new Map<string, number>();
  readonly #completedToolSegments = new Set<string>();
  #lastSequence = 0;
  #providerContinuationSamples = 0;
  #emptyProviderContinuationSamples = 0;
  #assistantContinuationSamples = 0;
  #latestUsageTotalTokens: number | null = null;
  #emptyContinuation: Extract<
    RunLifecycleEvent,
    { type: "segment.provider_continuation" }
  > | null = null;

  constructor(options: {
    runId: string;
    onInvalid: (code: string) => never;
    checkpoint?: RunExecutionProgressCheckpoint | null;
    purpose?: "execute" | "cancel";
  }) {
    this.#runId = options.runId;
    this.#invalid = options.onInvalid;
    // Cancellation must also settle older valid histories up to the Store's pending-call limit.
    this.#pendingToolLimit = options.purpose === "cancel" ? 128 : 16;
    if (options.checkpoint) {
      const saved = parseRunProgressCheckpoint(
        options.checkpoint,
        options.onInvalid,
        { pendingTools: this.#pendingToolLimit },
      );
      this.#lastSequence = options.checkpoint.throughSequence;
      this.#lastEventId = options.checkpoint.sourceEventId;
      for (const reference of saved.pendingTools)
        this.#pending.set(reference.callId, reference);
      for (const [id, sequence] of saved.segmentSequences)
        this.#segmentSequences.set(id, sequence);
      for (const id of saved.completedToolSegments)
        this.#completedToolSegments.add(id);
      this.#providerContinuationSamples = saved.providerContinuationSamples;
      this.#emptyProviderContinuationSamples =
        saved.emptyProviderContinuationSamples;
      this.#assistantContinuationSamples = saved.assistantContinuationSamples;
      this.#latestUsageTotalTokens = saved.latestUsageTotalTokens;
      this.#emptyContinuationSequence = saved.emptyContinuationSequence;
    }
  }

  get throughSequence(): number {
    return this.#lastSequence;
  }

  checkpoint(): RunExecutionProgressCheckpoint {
    const saved: SavedRunProgress = {
      schemaVersion: "crewon.run-execution-progress.v1",
      pendingTools: [...this.#pending.values()],
      segmentSequences: [...this.#segmentSequences],
      completedToolSegments: [...this.#completedToolSegments],
      providerContinuationSamples: this.#providerContinuationSamples,
      emptyProviderContinuationSamples: this.#emptyProviderContinuationSamples,
      assistantContinuationSamples: this.#assistantContinuationSamples,
      latestUsageTotalTokens: this.#latestUsageTotalTokens,
      emptyContinuationSequence: this.#emptyContinuationSequence,
    };
    const checkpoint = {
      throughSequence: this.#lastSequence,
      sourceEventId: this.#lastEventId,
      payload: JSON.stringify(saved),
    };
    parseRunProgressCheckpoint(checkpoint, this.#invalid, {
      pendingTools: this.#pendingToolLimit,
    });
    return checkpoint;
  }

  missingReferenceSequences(): readonly number[] {
    return [
      ...new Set([
        ...[...this.#pending.values()]
          .filter((ref) => !this.#pendingEvents.has(ref.callId))
          .map((ref) => ref.sequence),
        ...(this.#emptyContinuationSequence !== null &&
        this.#emptyContinuation === null
          ? [this.#emptyContinuationSequence]
          : []),
      ]),
    ].sort((a, b) => a - b);
  }

  hydrate(event: RunLifecycleEvent): void {
    if (
      event.identity.runId !== this.#runId ||
      event.sequence > this.#lastSequence
    )
      this.#invalid("run_execution_progress_reference_invalid");
    if (event.type === "tool.requested") {
      const ref = this.#pending.get(event.data.callId);
      if (
        !ref ||
        ref.sequence !== event.sequence ||
        ref.segmentId !== event.data.segmentId ||
        ref.segmentSequence !== event.data.segmentSequence
      )
        this.#invalid("run_execution_progress_reference_invalid");
      this.#pendingEvents.set(event.data.callId, event);
    } else if (
      event.type === "segment.provider_continuation" &&
      event.sequence === this.#emptyContinuationSequence &&
      isEmptyProviderContinuationSource(event.data.emptyContinuation) &&
      event.data.sampleIndex === this.#providerContinuationSamples
    ) {
      this.#emptyContinuation = event;
    } else this.#invalid("run_execution_progress_reference_invalid");
  }

  accept(event: RunLifecycleEvent): void {
    if (
      event.identity.runId !== this.#runId ||
      event.sequence !== this.#lastSequence + 1
    )
      this.#invalid("run_event_history_incomplete");
    this.#lastSequence = event.sequence;
    this.#lastEventId = event.eventId;
    if (
      "segmentId" in event.data &&
      "segmentSequence" in event.data &&
      this.#segmentSequences.has(event.data.segmentId)
    ) {
      this.#segmentSequences.set(
        event.data.segmentId,
        Math.max(
          this.#segmentSequences.get(event.data.segmentId)!,
          event.data.segmentSequence,
        ),
      );
    }
    if (event.type === "context.compacted") {
      this.#latestUsageTotalTokens = null;
      this.#emptyContinuation = null;
      this.#emptyContinuationSequence = null;
    } else if (event.type === "usage.recorded")
      this.#latestUsageTotalTokens = event.data.totalTokens;
    else if (event.type === "tool.requested") {
      if (this.#pending.has(event.data.callId))
        this.#invalid("model_history_tool_call_duplicate");
      if (this.#pending.size >= this.#pendingToolLimit)
        this.#invalid("run_execution_progress_pending_tool_limit_exceeded");
      this.#pending.set(event.data.callId, {
        callId: event.data.callId,
        segmentId: event.data.segmentId,
        sequence: event.sequence,
        segmentSequence: event.data.segmentSequence,
      });
      this.#pendingEvents.set(event.data.callId, event);
      this.#segmentSequences.set(
        event.data.segmentId,
        Math.max(
          this.#segmentSequences.get(event.data.segmentId) ?? 0,
          event.data.segmentSequence,
        ),
      );
    } else if (event.type === "tool.completed") {
      if (
        !this.#completedToolSegments.has(event.data.segmentId) &&
        this.#completedToolSegments.size >= 128
      )
        this.#invalid("run_execution_progress_completed_tool_limit_exceeded");
      this.#pending.delete(event.data.callId);
      this.#pendingEvents.delete(event.data.callId);
      this.#emptyContinuation = null;
      this.#emptyContinuationSequence = null;
      this.#completedToolSegments.add(event.data.segmentId);
      if (
        ![...this.#pending.values()].some(
          (item) => item.segmentId === event.data.segmentId,
        )
      )
        this.#segmentSequences.delete(event.data.segmentId);
    } else if (event.type === "segment.provider_continuation") {
      if (
        event.data.sampleIndex !== this.#providerContinuationSamples + 1 ||
        (event.data.emptyContinuation !== undefined &&
          !isEmptyProviderContinuationSource(event.data.emptyContinuation))
      )
        this.#invalid("provider_continuation_sequence_invalid");
      this.#providerContinuationSamples = event.data.sampleIndex;
      if (event.data.emptyContinuation !== undefined)
        this.#emptyProviderContinuationSamples++;
      this.#emptyContinuation =
        event.data.emptyContinuation === undefined ? null : event;
      this.#emptyContinuationSequence =
        this.#emptyContinuation === null ? null : event.sequence;
      if (
        ![...this.#pending.values()].some(
          (item) => item.segmentId === event.data.segmentId,
        )
      )
        this.#assistantContinuationSamples++;
    }
  }

  snapshot() {
    if (this.missingReferenceSequences().length > 0)
      this.#invalid("run_execution_progress_reference_missing");
    return {
      pendingTools: [...this.#pending.values()].map(
        (ref) => this.#pendingEvents.get(ref.callId)!,
      ),
      emptyContinuation: this.#emptyContinuation,
      lastSegmentSequence: Math.max(0, ...this.#segmentSequences.values()),
      completedToolRounds: this.#completedToolSegments.size,
      providerContinuationSamples: this.#providerContinuationSamples,
      emptyProviderContinuationSamples: this.#emptyProviderContinuationSamples,
      assistantContinuationSamples: this.#assistantContinuationSamples,
      latestUsageTotalTokens: this.#latestUsageTotalTokens,
    };
  }
}
