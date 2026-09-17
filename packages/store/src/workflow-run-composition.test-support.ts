import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type {
  WorkflowRunCompositionStore,
  WorkItemClaim,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
  workflowOutputSchema,
  type WorkflowNodeDefinition,
  type WorkflowObjectSchema,
} from "@crewon/domain";
import {
  admissionVersion,
  sqliteAdmissionFixture,
} from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { ManualLeaseClock } from "./run-store-conformance.test-support.ts";
import type { SqliteWorkflowCompositionOptions } from "./sqlite-workflow-run-composition.ts";
import type { SqliteRunStore } from "./sqlite-run-store.ts";

export const compositionNow = Date.parse("2026-09-14T00:00:00.000Z");
export type CompositionInput = Parameters<
  WorkflowRunCompositionStore["admitWorkflowNodes"]
>[0];
export async function compositionFixture(
  t: TestContext,
  options: {
    asset?: ReturnType<typeof admissionVersion>;
    inputSchema?: WorkflowObjectSchema;
    composition?: SqliteWorkflowCompositionOptions;
    nowEpochMs?: number;
  } = {},
) {
  const clock = new ManualLeaseClock(options.nowEpochMs ?? compositionNow);
  const f = await sqliteAdmissionFixture(t, options.inputSchema, {
    clock,
    asset: options.asset,
  });
  const started = await f.start();
  const claim = await claimCompositionWork(f.store, "first");
  const input = compositionInput(
    started.run.state.workflowVersionBinding!,
    claim,
  );
  await f.store.commitLeasedRun({
    lease: input.lease,
    history: null,
    commit: {
      tenantId: input.tenantId,
      expectedRevision: 1,
      idempotency: {
        scope: "composition-start",
        key: input.runId,
        requestFingerprint: "start",
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: input.runId },
          eventId: "start-event",
          sequence: 2,
          occurredAt: new Date(compositionNow).toISOString(),
          type: "run.started",
          data: {},
        },
      ],
      outbox: [],
      workItems: [],
    },
  });
  let ids = 0;
  const composition = f.store.experimentalWorkflowRunCompositionStore({
    nextId: () => `composition-${++ids}`,
    ...options.composition,
  });
  return {
    ...f,
    clock,
    input,
    composition,
    ids: () => ids,
    snapshot: () => compositionSnapshot(f.database),
    async nextInput() {
      await f.store.completeWorkItem(input.lease);
      return compositionInput(
        input.binding,
        await claimCompositionWork(f.store, `next-${++ids}`),
      );
    },
  };
}

export async function claimCompositionWork(store: SqliteRunStore, id: string) {
  const claim = await store.claimNextWorkItem({
    ownerId: `owner-${id}`,
    leaseId: `lease-${id}`,
    leaseDurationMs: 60_000,
  });
  assert.ok(claim);
  return claim;
}
export function compositionInput(
  binding: CompositionInput["binding"],
  claim: WorkItemClaim,
): CompositionInput {
  return {
    tenantId: claim.workItem.tenantId,
    runId: claim.workItem.runId,
    binding,
    lease: {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    },
    schedulerOperationId: String(claim.workItem.payload.schedulerOperationId),
    leaseDurationMs: 30_000,
  };
}
export function compositionSnapshot(database: DatabaseSync) {
  return Object.fromEntries(
    [
      "workflow_executions",
      "workflow_node_admissions",
      "workflow_node_passes",
      "run_steps",
      "run_attempts",
      "work_items",
    ].map((table) => [
      table,
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}
export function parallelVersion(
  count: number,
  kind: "agent" | "humanGate" = "agent",
  schema?: WorkflowObjectSchema,
) {
  const asset = admissionVersion(schema),
    base = parseCompiledWorkflowVersion(
      asset.definitionJson,
      workflowAdmissionDigest,
    );
  const nodes: WorkflowNodeDefinition[] = Array.from(
    { length: count },
    (_, index) => ({
      nodeId: `root-${index}`,
      title: `Root ${index}`,
      instruction: "Execute",
      dependsOn: [],
      inputSchema: base.inputSchema,
      outputSchema: base.inputSchema,
      ...(kind === "agent"
        ? { kind: "agent" as const, agentVersionId: `agent-${index}` }
        : { kind: "humanGate" as const, approvalPolicyId: "policy-1" }),
    }),
  );
  const entryNodeIds = nodes.map((node) => node.nodeId);
  const resultSchema = workflowOutputSchema({
    nodes,
    outputNodeIds: entryNodeIds,
  });
  nodes.push({
    kind: "verification",
    nodeId: "verify",
    title: "Verify",
    instruction: "Verify",
    verifierAgentVersionId: "verifier-1",
    dependsOn: entryNodeIds,
    inputSchema: resultSchema,
    outputSchema: base.inputSchema,
  });
  const outputNodeIds = ["verify"];
  const compiled = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: base.workflowId,
      workflowVersionId: base.workflowVersionId,
      name: base.name,
      description: base.description,
      inputSchema: base.inputSchema,
      outputSchema: workflowOutputSchema({ nodes, outputNodeIds }),
      nodes,
      entryNodeIds,
      outputNodeIds,
    },
    workflowAdmissionDigest,
  );
  return {
    ...asset,
    contentDigest: compiled.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(compiled),
  };
}
