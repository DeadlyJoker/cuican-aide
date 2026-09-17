import type { TestContext } from "node:test";
import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import { RunExecutionService } from "@crewon/application";
import type { ToolRuntimePort } from "@crewon/tool-broker";
import type { compositionFixture } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
let workerSerial = 0;

export function childWorker(
  f: Pick<Awaited<ReturnType<typeof compositionFixture>>, "open" | "clock">,
  t: TestContext,
  transport: ModelTransportPort,
  toolRuntime?: ToolRuntimePort,
  agentVersionId = "agent-1",
) {
  const store = f.open(),
    callbacks = new Set<() => Promise<void>>();
  const prefix = `cancel-worker-${++workerSerial}`;
  let ids = 0;
  const worker = new RuntimeWorker(
    {
      store,
      kernel: new CrewONAgentKernel({ transport }),
      toolRuntime,
      execution: new RunExecutionService({
        store,
        clock: {
          now: () => new Date(f.clock.nowEpochMilliseconds()).toISOString(),
        },
        ids: { nextId: () => `${prefix}-event-${++ids}` },
        digester: workflowAdmissionDigest,
      }),
      policy: new PinnedRunExecutionPolicy({
        authorityId: "authority-1",
        runtimeGeneration: "ts-v0",
        policySnapshotId: "policy-1",
        workspaceBindingId: "workspace-1",
        agentVersionId,
      }),
    },
    {
      ownerId: prefix,
      nextLeaseId: () => `${prefix}-lease-${++ids}`,
      scanIntervalMs: null,
      leaseDurationMs: 30_000,
      cancellationPollIntervalMs: 1,
      cancellationScheduler: {
        every: (_ms, callback) => {
          callbacks.add(callback);
          return () => {
            callbacks.delete(callback);
          };
        },
      },
    },
  );
  t.after(async () => {
    await worker.close();
    await store.close();
  });
  return {
    worker,
    // Tests use a separate manual root coordinator. Keep ordinary queue claims
    // real and explicitly advance through scheduler-unavailable handoffs.
    wakeChild: async () => {
      for (let pass = 0; pass < 8; pass++) {
        const outcome = await worker.wake();
        if (
          outcome.kind !== "retried" ||
          outcome.code !== "workflow_scheduler_unavailable"
        )
          return outcome;
        f.clock.advance(1000);
      }
      throw new Error("fixture_child_not_scheduled");
    },
    callbacks,
    store,
    tick: () => Promise.all([...callbacks].map((callback) => callback())),
  };
}
