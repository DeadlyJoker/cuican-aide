import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import { RunExecutionService } from "@crewon/application";
import { parseCompiledWorkflowVersion } from "@crewon/domain";
import type { postgresCompositionFixture } from "../../../packages/store/src/postgres-workflow-composition.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import { compositionInput } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
import { RuntimeWorker } from "./runtime-worker.ts";

type Fixture = Awaited<ReturnType<typeof postgresCompositionFixture>>;
type Request = Parameters<ModelTransportPort["stream"]>[0];
let serial = 0;

/** Real ordinary Worker with a synthetic model and the frozen fixture's explicit agent routes. */
export async function postgresWorkflowChildWorker(
  f: Fixture,
  t: TestContext,
  output: (request: Request) => string = () => '{"topic":"child-result"}',
) {
  const store = await f.open();
  const workflow = parseCompiledWorkflowVersion(
    f.asset.definitionJson,
    workflowAdmissionDigest,
  );
  const agents = new Set(
    workflow.nodes.flatMap((node) =>
      node.kind === "agent"
        ? [node.agentVersionId]
        : node.kind === "verification"
          ? [node.verifierAgentVersionId]
          : [],
    ),
  );
  const prefix = `pg-result-worker-${++serial}`;
  let ids = 0;
  const requests: Request[] = [];
  const worker = new RuntimeWorker(
    {
      store,
      execution: new RunExecutionService({
        store,
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => `${prefix}-event-${++ids}` },
        digester: workflowAdmissionDigest,
      }),
      policy: {
        evaluate: async (input) => {
          if (!agents.has(input.run.agentVersionId))
            return {
              outcome: "deny",
              reasonCode: "fixture_agent_not_registered",
            };
          return new PinnedRunExecutionPolicy({
            authorityId: f.root.authorityId,
            runtimeGeneration: f.root.runtimeGeneration,
            policySnapshotId: f.root.policySnapshotId,
            workspaceBindingId: f.root.workspaceBindingId,
            agentVersionId: input.run.agentVersionId,
          }).evaluate(input);
        },
      },
      kernel: new CrewONAgentKernel({
        transport: {
          adapterName: "synthetic-pg-result",
          adapterVersion: "1",
          modelId: "synthetic",
          async *stream(request) {
            requests.push(structuredClone(request));
            const value = output(request);
            const midpoint = Math.floor(value.length / 2);
            yield { type: "output.delta", delta: value.slice(0, midpoint) };
            yield { type: "output.delta", delta: value.slice(midpoint) };
            yield { type: "completed", checkpoint: null };
          },
        },
      }),
    },
    {
      ownerId: prefix,
      nextLeaseId: () => `${prefix}-lease-${++ids}`,
      scanIntervalMs: null,
      leaseDurationMs: 60_000,
      cancellationScheduler: { every: () => () => {} },
    },
  );
  t.after(() => worker.close());
  return { worker, store, requests };
}

/** Explicit parent acknowledgement; the production scheduler is intentionally still disabled. */
export async function claimPostgresParentWake(
  f: Fixture,
  previous: typeof f.input,
) {
  await f.store.completeWorkItem(previous.lease);
  const claim = await f.store.claimNextWorkItem({
    ownerId: "result-parent",
    leaseId: `result-parent-${Date.now()}`,
    leaseDurationMs: 60_000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, f.root.runId);
  return compositionInput(f.input.binding, claim);
}
