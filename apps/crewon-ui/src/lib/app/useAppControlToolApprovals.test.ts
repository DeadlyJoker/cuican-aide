import { describe, expect, it } from "vitest";

import type { ControlToolApprovalPrompt } from "../control-runtime/controlToolApprovalPresentation";
import { transitionControlToolApprovals } from "./useAppControlToolApprovals";

const request = {
  approvalId: "approval-1",
  runId: "run-1",
  threadId: "thread-1",
  toolName: "workspace.write",
} as const;

describe("transitionControlToolApprovals", () => {
  it("records and resolves a required approval", () => {
    const required = transitionControlToolApprovals(new Map(), {
      type: "required",
      request,
    });

    expect(required.get(request.threadId)).toEqual({
      ...request,
      busy: false,
    });
    expect(
      transitionControlToolApprovals(required, {
        type: "resolved",
        threadId: request.threadId,
        runId: request.runId,
      }),
    ).toEqual(new Map());
  });

  it("keeps a replacement approval when an older run resolves late", () => {
    const replacement = {
      ...request,
      approvalId: "approval-2",
      runId: "run-2",
    };
    const current = approvalMap({ ...replacement, busy: false });

    expect(
      transitionControlToolApprovals(current, {
        type: "resolved",
        threadId: request.threadId,
        runId: request.runId,
      }),
    ).toBe(current);
  });

  it("tracks a failed decision and clears a successful retry", () => {
    const required = approvalMap({ ...request, busy: false });
    const started = transitionControlToolApprovals(required, {
      type: "decisionStarted",
      request,
    });
    const failed = transitionControlToolApprovals(started, {
      type: "decisionFailed",
      request,
      error: "network unavailable",
    });

    expect(started.get(request.threadId)).toEqual({ ...request, busy: true });
    expect(failed.get(request.threadId)).toEqual({
      ...request,
      busy: false,
      error: "network unavailable",
    });
    expect(
      transitionControlToolApprovals(failed, {
        type: "decisionSucceeded",
        request,
      }),
    ).toEqual(new Map());
  });

  it("ignores a stale decision response for a replacement approval", () => {
    const replacement = { ...request, approvalId: "approval-2" };
    const current = approvalMap({ ...replacement, busy: false });

    expect(
      transitionControlToolApprovals(current, {
        type: "decisionSucceeded",
        request,
      }),
    ).toBe(current);
    expect(
      transitionControlToolApprovals(current, {
        type: "decisionFailed",
        request,
        error: "stale failure",
      }),
    ).toBe(current);
  });
});

function approvalMap(
  prompt: ControlToolApprovalPrompt,
): ReadonlyMap<string, ControlToolApprovalPrompt> {
  return new Map([[prompt.threadId, prompt]]);
}
