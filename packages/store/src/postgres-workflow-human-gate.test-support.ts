import {
  compileWorkflowVersion,
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import type { TestContext } from "node:test";
import { postgresCompositionFixture } from "./postgres-workflow-composition.test-support.ts";
import { parallelVersion } from "./workflow-run-composition.test-support.ts";
import { gateActor, gateCommand } from "./workflow-human-gate.test-support.ts";
import type { WorkflowExecutionState } from "@crewon/application";
import type { PostgresWorkflowHumanGateAuthorization } from "./postgres-workflow-human-gates.ts";
export { gateActor, gateCommand };
export const authorizePostgresTestGate: PostgresWorkflowHumanGateAuthorization =
  ({ actor, authority }) =>
    actor.actorId === gateActor.actorId &&
    actor.principalId === gateActor.principalId &&
    ["policy-1", "review-policy"].includes(authority.approvalPolicyId)
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "fixture_gate_policy_denied" };

export async function postgresGateFixture(
  t: TestContext,
  options: Parameters<typeof postgresCompositionFixture>[1] = {},
) {
  const f = await postgresCompositionFixture(t, {
    asset: parallelVersion(2, "humanGate"),
    ...options,
    composition: {
      humanGates: { authorize: authorizePostgresTestGate },
      ...options.composition,
    },
  });
  const state = async () =>
    (
      await f.admin.query<{ state_json: WorkflowExecutionState }>(
        `SELECT state_json FROM ${f.sql}.workflow_executions WHERE tenant_id=$1 AND run_id=$2`,
        [f.root.tenantId, f.root.runId],
      )
    ).rows[0]!.state_json;
  const snapshot = async (): Promise<
    Awaited<ReturnType<typeof f.snapshot>>
  > => ({
    ...(await f.snapshot()),
    workflow_human_gates: (
      await f.admin.query(
        `SELECT * FROM ${f.sql}.workflow_human_gates ORDER BY node_id`,
      )
    ).rows,
  });
  return { ...f, state, snapshot };
}
export async function parkedPostgresGates(
  t: TestContext,
  options: Parameters<typeof postgresGateFixture>[1] = {},
) {
  const f = await postgresGateFixture(t, options);
  const admitted = await f.composition.admitWorkflowNodes(f.input);
  await f.composition.finishWorkflowSchedulerPass(f.input);
  return { ...f, command: gateCommand(admitted.execution, "root-0") };
}

export function mixedGateVersion() {
  const asset = parallelVersion(2);
  const base = parseCompiledWorkflowVersion(
    asset.definitionJson,
    workflowAdmissionDigest,
  );
  const first = base.nodes[0]!;
  const compiled = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: base.workflowId,
      workflowVersionId: base.workflowVersionId,
      name: base.name,
      description: base.description,
      inputSchema: base.inputSchema,
      outputSchema: base.outputSchema,
      entryNodeIds: base.entryNodeIds,
      outputNodeIds: base.outputNodeIds,
      nodes: [
        {
          nodeId: first.nodeId,
          title: first.title,
          instruction: first.instruction,
          inputSchema: first.inputSchema,
          outputSchema: first.outputSchema,
          dependsOn: [],
          kind: "humanGate",
          approvalPolicyId: "review-policy",
        },
        ...base.nodes.slice(1),
      ],
    },
    workflowAdmissionDigest,
  );
  return {
    ...asset,
    contentDigest: compiled.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(compiled),
  };
}
