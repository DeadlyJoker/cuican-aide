import { useEffect, useRef } from "react";
import type { WorkflowRunObserver } from "../../lib/control-runtime/controlDurableWorkflowRuntime";
import { waitForControlRuntimeDelay } from "../../lib/control-runtime/controlRuntimeDelay";

/** Root SSE invalidates reads; only a canonical snapshot can finish the room.
 * Node progress and outages retain the existing bounded polling fallback.
 */
export function useWorkflowRootEvents(input: {
  enabled: boolean;
  workflowVersionId: string | null;
  runId: string | null;
  afterSequence: number;
  sourceIdentity?: object | null;
  observe?: WorkflowRunObserver;
  reload(): Promise<void>;
}): void {
  const callbacks = useRef({ observe: input.observe, reload: input.reload });
  useEffect(() => {
    callbacks.current = { observe: input.observe, reload: input.reload };
  }, [input.observe, input.reload]);
  useEffect(() => {
    if (
      !input.enabled ||
      !input.workflowVersionId ||
      !input.runId ||
      !callbacks.current.observe
    )
      return;
    const controller = new AbortController();
    const scope = {
      workflowVersionId: input.workflowVersionId,
      runId: input.runId,
    };
    let afterSequence = input.afterSequence;
    const terminal = new Set(["run.completed", "run.failed", "run.canceled"]);
    const invalidate = new Set([
      ...terminal,
      "run.started",
      "run.cancel.requested",
      "run.suspended",
      "run.reconciliation.required",
      "run.resumed",
    ]);
    const run = async () => {
      let failures = 0;
      while (!controller.signal.aborted) {
        try {
          const observe = callbacks.current.observe;
          if (!observe) return;
          for await (const event of observe(
            { ...scope, afterSequence },
            controller.signal,
          )) {
            if (controller.signal.aborted) return;
            if (event.sequence <= afterSequence) continue;
            afterSequence = event.sequence;
            failures = 0;
            if (invalidate.has(event.type)) await callbacks.current.reload();
            if (terminal.has(event.type)) return;
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        // EOF is not completion. Reconnect with the original Run and last
        // consumed sequence; never submit or infer a terminal state here.
        await waitForControlRuntimeDelay({
          delayMs: Math.min(15000, 1000 * 2 ** Math.min(failures++, 4)),
          signal: controller.signal,
        });
      }
    };
    // StrictMode cleanup can retire the first owner before opening a request.
    void Promise.resolve().then(run);
    return () => controller.abort();
  }, [
    input.enabled,
    input.workflowVersionId,
    input.runId,
    input.sourceIdentity,
  ]);
}
