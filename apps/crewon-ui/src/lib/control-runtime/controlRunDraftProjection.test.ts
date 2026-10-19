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
  it("projects tool continuation, retries and the first real output as phase changes without per-chunk activity updates", () => {
    let state = createControlRunDraftProjectionState();
    const apply = (
      sequence: number,
      value: Pick<RunEventView, "type" | "data">,
    ) => {
      const result = applyControlRunDraftEvent(state, event(sequence, value));
      state = result.state;
      return result;
    };
    expect(
      apply(1, {
        type: "tool.completed",
        data: {
          segmentId: "segment-1",
          callId: "tool-1",
          kind: "function",
          name: "read",
          isError: false,
          outputTruncated: false,
          artifactAvailable: false,
        },
      }).modelActivity,
    ).toBe("waiting");
    expect(
      apply(2, {
        type: "segment.started",
        data: { segmentId: "segment-2", attempt: 1 },
      }).modelActivity,
    ).toBeUndefined();
    expect(
      apply(3, {
        type: "model.sampling.retry",
        data: {
          segmentId: "segment-2",
          samplingAttempt: 2,
          maxRetries: 3,
          code: "responses_idle_timeout",
          discardedOutput: false,
        },
      }).modelActivity,
    ).toBe("retrying");
    expect(
      apply(4, {
        type: "model.output.delta",
        data: { segmentId: "segment-2", delta: " \n" },
      }).modelActivity,
    ).toBeUndefined();
    expect(state.modelActivity).toBe("retrying");
    expect(
      apply(5, {
        type: "model.output.delta",
        data: { segmentId: "segment-2", delta: "后续正文" },
      }).modelActivity,
    ).toBeNull();
    for (let index = 6; index < 1006; index++)
      expect(
        apply(index, {
          type: "model.output.delta",
          data: { segmentId: "segment-2", delta: "文字" },
        }).modelActivity,
      ).toBeUndefined();
    expect(
      apply(1006, {
        type: "run.completed",
        data: { outputRef: "message:final" },
      }).modelActivity,
    ).toBeUndefined();
    expect(state.modelActivity).toBeUndefined();
  });

  it.each([
    "run.completed",
    "run.failed",
    "run.canceled",
    "tool.requested",
  ] as const)(
    "clears retry presentation on %s without waiting for canonical output",
    (type) => {
      const current = {
        segmentId: "segment-1",
        modelActivity: "retrying" as const,
      };
      const value =
        type === "run.completed"
          ? { type, data: { outputRef: null } }
          : type === "run.failed"
            ? { type, data: { code: "provider_failed", retryable: false } }
            : type === "run.canceled"
              ? { type, data: { reason: "user_request" } }
              : {
                  type,
                  data: {
                    segmentId: "segment-1",
                    callId: "tool-1",
                    name: "read",
                    kind: "function",
                  },
                };
      const result = applyControlRunDraftEvent(
        current,
        event(9, value as Pick<RunEventView, "type" | "data">),
      );
      expect(result.modelActivity).toBeNull();
      expect(result.state.modelActivity).toBeUndefined();
    },
  );

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
