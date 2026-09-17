import type { TestContext } from "node:test";
import {
  CrewONAgentKernel,
  type ModelRequest,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  RunExecutionService,
  type WorkflowRunSchedulerStore,
} from "@crewon/application";
import type { ToolRuntimePort } from "@crewon/tool-broker";
import type { schedulerFixture } from "../../../packages/store/src/workflow-scheduler.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { ExperimentalWorkflowScheduler } from "./workflow-scheduler.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
let serial = 0;

export function schedulerWorker(
  f: Awaited<ReturnType<typeof schedulerFixture>>,
  t: TestContext,
  options: {
    transport?: ModelTransportPort;
    toolRuntime?: ToolRuntimePort;
    afterAdmit?: () => Promise<void>;
  } = {},
) {
  const store = f.open();
  const composition = store.experimentalWorkflowRunCompositionStore(f.options);
  const prefix = `scheduler-worker-${++serial}`;
  let ids = 0;
  const requests: ModelRequest[] = [];
  const transport: ModelTransportPort = options.transport ?? {
    adapterName: "workflow-scheduler-fixture",
    adapterVersion: "1",
    modelId: "synthetic",
    async *stream(request) {
      requests.push(request);
      const run = await store.loadRun({
        tenantId: f.root.tenantId,
        runId: request.runId,
      });
      const output = JSON.stringify({
        topic:
          run!.agentVersionId === "verifier-1" ? "verified" : "agent-result",
      });
      yield { type: "output.delta", delta: output };
      yield {
        type: "usage",
        inputTokens: 90,
        cachedInputTokens: 64,
        outputTokens: 12,
        totalTokens: 102,
      };
      yield { type: "completed", checkpoint: null };
    },
  };
  const workflow: WorkflowRunSchedulerStore = {
    prepareWorkflowRun: (input) => composition.prepareWorkflowRun(input),
    async admitWorkflowNodes(input) {
      const result = await composition.admitWorkflowNodes(input);
      await options.afterAdmit?.();
      return result;
    },
    propagateWorkflowCancellation: (input) =>
      composition.propagateWorkflowCancellation(input),
    finalizeWorkflowRun: (input) => composition.finalizeWorkflowRun(input),
    finishWorkflowSchedulerPass: (input) =>
      composition.finishWorkflowSchedulerPass(input),
  };
  const worker = new RuntimeWorker(
    {
      store,
      execution: new RunExecutionService({
        store,
        clock: {
          now: () => new Date(f.clock.nowEpochMilliseconds()).toISOString(),
        },
        ids: { nextId: () => `${prefix}-event-${++ids}` },
        digester: workflowAdmissionDigest,
      }),
      kernel: new CrewONAgentKernel({ transport }),
      toolRuntime: options.toolRuntime,
      policy: {
        evaluate: (input) =>
          new PinnedRunExecutionPolicy({
            authorityId: "authority-1",
            runtimeGeneration: "ts-v0",
            policySnapshotId: "policy-1",
            workspaceBindingId: "workspace-1",
            agentVersionId: input.run.agentVersionId,
          }).evaluate(input),
      },
      experimentalWorkflowScheduler: new ExperimentalWorkflowScheduler(
        store,
        workflow,
      ),
    },
    {
      ownerId: prefix,
      nextLeaseId: () => `${prefix}-lease-${++ids}`,
      scanIntervalMs: null,
      leaseDurationMs: 30_000,
    },
  );
  t.after(async () => {
    await worker.close();
    await store.close();
  });
  return { worker, store, requests, composition };
}

export async function drainScheduler(worker: RuntimeWorker, limit = 64) {
  const outcomes = [];
  for (let count = 0; count < limit; count++) {
    const outcome = await worker.wake();
    outcomes.push(outcome);
    if (outcome.kind === "idle") return outcomes;
  }
  throw Error("scheduler fixture exceeded bounded drain");
}
