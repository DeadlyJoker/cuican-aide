import { useCallback, useState } from "react";

import type {
  ControlToolApprovalPrompt,
  ControlToolApprovalRequest,
} from "../control-runtime/controlToolApprovalPresentation";

type ToolApprovalDecision = "approved" | "rejected";

type ToolApprovalTransition =
  | Readonly<{
      type: "required";
      request: ControlToolApprovalRequest;
    }>
  | Readonly<{
      type: "resolved";
      threadId: string;
      runId: string;
    }>
  | Readonly<{
      type: "decisionStarted";
      request: ControlToolApprovalRequest;
    }>
  | Readonly<{
      type: "decisionSucceeded";
      request: ControlToolApprovalRequest;
    }>
  | Readonly<{
      type: "decisionFailed";
      request: ControlToolApprovalRequest;
      error: string;
    }>;

export function transitionControlToolApprovals(
  current: ReadonlyMap<string, ControlToolApprovalPrompt>,
  transition: ToolApprovalTransition,
): ReadonlyMap<string, ControlToolApprovalPrompt> {
  if (transition.type === "required") {
    const next = new Map(current);
    next.set(transition.request.threadId, {
      ...transition.request,
      busy: false,
    });
    return next;
  }

  if (transition.type === "resolved") {
    if (current.get(transition.threadId)?.runId !== transition.runId) {
      return current;
    }
    const next = new Map(current);
    next.delete(transition.threadId);
    return next;
  }

  const existing = current.get(transition.request.threadId);
  if (existing?.approvalId !== transition.request.approvalId) return current;

  const next = new Map(current);
  if (transition.type === "decisionSucceeded") {
    next.delete(transition.request.threadId);
  } else if (transition.type === "decisionStarted") {
    next.set(transition.request.threadId, {
      ...transition.request,
      busy: true,
    });
  } else {
    next.set(transition.request.threadId, {
      ...transition.request,
      busy: false,
      error: transition.error,
    });
  }
  return next;
}

export function useAppControlToolApprovals() {
  const [approvals, setApprovals] = useState<
    ReadonlyMap<string, ControlToolApprovalPrompt>
  >(() => new Map());

  const requireApproval = useCallback((request: ControlToolApprovalRequest) => {
    setApprovals((current) =>
      transitionControlToolApprovals(current, { type: "required", request }),
    );
  }, []);

  const resolveApproval = useCallback((threadId: string, runId: string) => {
    setApprovals((current) =>
      transitionControlToolApprovals(current, {
        type: "resolved",
        threadId,
        runId,
      }),
    );
  }, []);

  const decideApproval = useCallback(
    async ({
      decide,
      decision,
      onFailure,
      request,
    }: Readonly<{
      decide: (
        approvalId: string,
        decision: ToolApprovalDecision,
      ) => Promise<unknown>;
      decision: ToolApprovalDecision;
      onFailure: () => void;
      request: ControlToolApprovalRequest;
    }>): Promise<void> => {
      setApprovals((current) =>
        transitionControlToolApprovals(current, {
          type: "decisionStarted",
          request,
        }),
      );
      try {
        await decide(request.approvalId, decision);
        setApprovals((current) =>
          transitionControlToolApprovals(current, {
            type: "decisionSucceeded",
            request,
          }),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setApprovals((current) =>
          transitionControlToolApprovals(current, {
            type: "decisionFailed",
            request,
            error: message,
          }),
        );
        onFailure();
      }
    },
    [],
  );

  return {
    approvals,
    decideApproval,
    requireApproval,
    resolveApproval,
  };
}
