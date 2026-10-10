import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BeginThreadSubmission,
  type PendingThreadSubmission,
} from "./threadPendingSubmission";

/** Presentation only: temporary messages never enter the durable thread cache. */
export function usePendingThreadSubmissions(selectionEpochRef: {
  current: number;
}) {
  const [pendingThreadSubmissions, setPending] = useState<
    PendingThreadSubmission[]
  >([]);
  const sequence = useRef(0);
  const selectionEpoch = selectionEpochRef.current;
  const beginMessageSubmission = useCallback<BeginThreadSubmission>(
    (input) => {
      const id = `pending-user-${++sequence.current}`;
      const pending: PendingThreadSubmission = {
        id,
        threadId: input.threadId,
        turnId: null,
        item: {
          type: "userMessage",
          id,
          clientId: null,
          content: [
            { type: "text", text: input.text, text_elements: [] },
            ...input.images.map((image) => ({
              type: "image" as const,
              ...image,
            })),
          ],
        },
        baselineItemIds:
          input.thread?.turns.flatMap((turn) =>
            turn.items
              .filter((item) => item.type === "userMessage")
              .map((item) => item.id),
          ) ?? [],
        baselineTurnIds: input.thread?.turns.map((turn) => turn.id) ?? [],
        selectionEpoch: selectionEpochRef.current,
        isWorkspaceCurrent: input.isWorkspaceCurrent,
        phase: "sending",
        error: null,
      };
      // Only pending presentation is retained here, and failed retries replace
      // their previous local bubble. Bound attachment memory if a read never returns.
      setPending((current) =>
        [
          ...current.filter(
            (item) =>
              !(
                item.phase === "failed" && item.threadId === pending.threadId
              ) &&
              (item.threadId !== null ||
                item.selectionEpoch === selectionEpochRef.current),
          ),
          pending,
        ].slice(-32),
      );
      const update = (patch: Partial<PendingThreadSubmission>) =>
        setPending((current) =>
          current.map((item) =>
            item.id === id ? { ...item, ...patch } : item,
          ),
        );
      return {
        submissionId: id,
        bindThread: (threadId) => update({ threadId }),
        accepted: (threadId, turnId) =>
          update({ threadId, turnId, phase: "accepted" }),
        failed: (error) =>
          update({
            phase: "failed",
            error:
              error instanceof Error ? error.message : "Unable to send message",
          }),
      };
    },
    [selectionEpochRef],
  );
  useEffect(() => {
    setPending((current) => {
      const retained = current.filter(
        (pending) =>
          pending.isWorkspaceCurrent() &&
          (pending.threadId !== null ||
            pending.phase === "sending" ||
            pending.selectionEpoch === selectionEpoch),
      );
      return retained.length === current.length ? current : retained;
    });
  }, [selectionEpoch]);
  const acknowledgePresentedSubmissions = useCallback(
    (ids: readonly string[]) => {
      if (!ids.length) return;
      const presented = new Set(ids);
      setPending((current) => {
        const retained = current.filter(
          (pending) => !presented.has(pending.id),
        );
        return retained.length === current.length ? current : retained;
      });
    },
    [],
  );
  return {
    beginMessageSubmission,
    pendingThreadSubmissions,
    acknowledgePresentedSubmissions,
  };
}
