import type { ControlApiClient } from "@crewon/control-client";
import type { RunView } from "@crewon/contracts";
import { abortableCatalogRead as abortableRead } from "./controlCatalogRead";
import { waitForControlRuntimeDelay } from "./controlRuntimeDelay";

/** Reads only current authority. History pages cannot prove absence of an active Run. */
export async function cancelControlActiveRun(input: {
  client: Pick<ControlApiClient, "getThreadActiveRun" | "getRun" | "cancelRun">;
  threadId: string;
  signal: AbortSignal;
  idempotencyKey: () => string;
}): Promise<void> {
  const { client, threadId, signal } = input;
  signal.throwIfAborted();
  const active = await abortableRead(
    client.getThreadActiveRun(threadId, { signal }),
    signal,
  );
  if (active.threadId !== threadId)
    throw new Error("control_active_run_identity_invalid");
  if (active.run === null) return;
  const runId = active.run.runId;
  const terminal = (run: RunView): boolean => {
    if (run.threadId !== threadId || run.runId !== runId)
      throw new Error("control_active_run_identity_invalid");
    return ["completed", "failed", "canceled"].includes(run.status);
  };
  terminal(active.run);
  let current = (await abortableRead(client.getRun(runId, { signal }), signal))
    .run;
  if (!terminal(current)) {
    signal.throwIfAborted();
    current = (
      await abortableRead(
        client.cancelRun(
          runId,
          { expectedRevision: current.revision },
          input.idempotencyKey(),
          { signal },
        ),
        signal,
      )
    ).run;
  }
  while (!terminal(current)) {
    await waitForControlRuntimeDelay({ delayMs: 50, signal });
    signal.throwIfAborted();
    current = (await abortableRead(client.getRun(runId, { signal }), signal))
      .run;
  }
  signal.throwIfAborted();
}
