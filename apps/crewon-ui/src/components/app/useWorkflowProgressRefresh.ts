import { useEffect, useRef } from "react";

/** Refreshes the visible task independently of the submitting command's lifetime. */
export function useWorkflowProgressRefresh(input: {
  enabled: boolean;
  workflowId: string | null;
  executionId: string | null;
  cadence: "active" | "waitingForApproval";
  reload(): Promise<void>;
}): void {
  const reload = useRef(input.reload);
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    reload.current = input.reload;
  }, [input.reload]);

  useEffect(() => {
    if (!input.enabled || input.workflowId === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!live) return;
      // A slow read can outlive a task/view change. Join it before scheduling
      // the next read rather than starting another automatic request.
      const pending =
        inFlight.current ?? Promise.resolve().then(() => reload.current());
      inFlight.current = pending;
      try {
        await pending;
      } catch {
        // The read owner exposes availability. A rejected read is not a
        // reason to submit, cancel or assume the task has finished.
      } finally {
        if (inFlight.current === pending) inFlight.current = null;
        if (live)
          timer = setTimeout(
            () => void refresh(),
            input.cadence === "waitingForApproval" ? 15_000 : 2000,
          );
      }
    };
    timer = setTimeout(() => void refresh(), 2000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [input.enabled, input.workflowId, input.executionId, input.cadence]);
}
