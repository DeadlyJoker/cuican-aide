import { loadRunExecutionProgress } from "@crewon/application";
import type { KernelAgentEvent } from "@crewon/agent-kernel";

/** The application owns canonical progress; only Worker projects pending calls for Kernel execution. */
export async function loadRuntimeRunProgress(
  input: Parameters<typeof loadRunExecutionProgress>[0],
) {
  const result = await loadRunExecutionProgress(input);
  if (result.kind === "deferred") return result;
  const events: Extract<KernelAgentEvent, { type: "tool.requested" }>[] =
    result.progress.pendingTools.map((event) => ({
      schemaVersion: "crewon.agent-event.v0",
      runId: input.run.runId,
      segmentId: event.data.segmentId,
      sequence: event.data.segmentSequence,
      type: "tool.requested",
      data: {
        callId: event.data.callId,
        kind: event.data.kind,
        name: event.data.name,
        input: event.data.input,
      },
    }));
  return { kind: "ready" as const, progress: { ...result.progress, events } };
}
