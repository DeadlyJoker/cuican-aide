import { describe, expect, it } from "vitest";
import type { RunEventView } from "@crewon/contracts";

import {
  applyControlRunDraftEvent,
  createControlRunDraftProjectionState,
} from "./controlRunDraftProjection";

const occurredAt = "2026-09-03T10:00:00.000Z";

function event(
  sequence: number,
  value: Pick<RunEventView, "type" | "data">,
): RunEventView {
  return {
    eventId: `event-${sequence}`,
    runId: "run-1",
    sequence,
    occurredAt,
    ...value,
  } as RunEventView;
}

describe("control Run draft projection", () => {
  it("claims a fresh thread draft before replaying a segment", () => {
    const started = applyControlRunDraftEvent(
      createControlRunDraftProjectionState(),
      event(1, {
        type: "segment.started",
        data: { segmentId: "segment-1", attempt: 1 },
      }),
    );

    expect(started).toMatchObject({
      reset: true,
      state: { segmentId: "segment-1" },
    });
  });

  it("appends deltas and resets discarded retry output", () => {
    let state = createControlRunDraftProjectionState();
    state = applyControlRunDraftEvent(
      state,
      event(1, {
        type: "model.output.delta",
        data: { segmentId: "segment-1", delta: "stale" },
      }),
    ).state;

    const retry = applyControlRunDraftEvent(
      state,
      event(2, {
        type: "model.sampling.retry",
        data: {
          segmentId: "segment-1",
          samplingAttempt: 2,
          maxRetries: 3,
          code: "transient",
          discardedOutput: true,
        },
      }),
    );
    const replacement = applyControlRunDraftEvent(
      retry.state,
      event(3, {
        type: "model.output.delta",
        data: { segmentId: "segment-1", delta: "final" },
      }),
    );

    expect(retry).toMatchObject({
      reset: true,
      state: { segmentId: "segment-1" },
    });
    expect(replacement).toMatchObject({
      reset: false,
      delta: "final",
      state: { segmentId: "segment-1" },
    });
  });

  it("replaces a prior segment and clears failed or canceled drafts", () => {
    const prior = {
      segmentId: "segment-1",
    } as const;
    const started = applyControlRunDraftEvent(
      prior,
      event(2, {
        type: "segment.started",
        data: { segmentId: "segment-2", attempt: 2 },
      }),
    );
    const failed = applyControlRunDraftEvent(
      { segmentId: "segment-2" },
      event(3, {
        type: "run.failed",
        data: { code: "model_failed", retryable: false },
      }),
    );

    expect(started).toMatchObject({
      reset: true,
      state: { segmentId: "segment-2" },
    });
    expect(failed).toMatchObject({
      reset: true,
      state: { segmentId: null },
    });
  });

  it("keeps valid output through completion until the canonical Message arrives", () => {
    const current = { segmentId: "segment-1" } as const;

    expect(
      applyControlRunDraftEvent(
        current,
        event(2, {
          type: "run.completed",
          data: { outputRef: "message:message-1" },
        }),
      ),
    ).toEqual({ state: current, reset: false, delta: "" });
  });

  it("forwards a long stream exactly once without retaining a second copy of its text", () => {
    let state = createControlRunDraftProjectionState();
    let delivered = 0;
    for (let index = 0; index < 20_000; index++) {
      const delta = `${index}:` + "正文".repeat(2048);
      const result = applyControlRunDraftEvent(
        state,
        event(index + 1, {
          type: "model.output.delta",
          data: { segmentId: "segment-long", delta },
        }),
      );
      expect(result.delta).toBe(delta);
      expect(result.reset).toBe(false);
      delivered += result.delta.length;
      state = result.state;
    }
    expect(delivered).toBeGreaterThan(80_000_000);
    expect(state).toEqual({ segmentId: "segment-long" });
  });
});
