import { parseWorkflowRunSnapshotResponse } from "@crewon/contracts";
import {
  initialWorkflowExecution,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type { decodeWorkflowCompositionContext } from "./workflow-composition-context.ts";
import type { WorkflowNodeRow } from "./workflow-node-authority.ts";
import type { WorkflowHumanGateRow } from "./workflow-human-gate-authority.ts";

/** Canonical, bounded display projection shared by both physical snapshots. */
export function workflowReadProjection(
  run: RunState,
  context: ReturnType<typeof decodeWorkflowCompositionContext>,
  execution: WorkflowExecutionState | null,
  rows: ReadonlyMap<string, WorkflowNodeRow>,
  children: ReadonlyMap<string, RunState>,
  gates: ReadonlyMap<string, WorkflowHumanGateRow>,
) {
  const state =
    execution ??
    initialWorkflowExecution({
      tenantId: run.tenantId,
      runId: run.runId,
      workflow: context.workflow,
      now: run.createdAt,
    });
  const nodes = state.nodes.map((node) => {
    const definition = context.workflow.nodes.find(
      (value) => value.nodeId === node.nodeId,
    )!;
    const child =
      node.claimId === null ? null : (children.get(node.claimId) ?? null);
    const gate = gates.get(node.nodeId)?.authority ?? null;
    const output = rows.get(node.nodeId)?.output_json;
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      title: definition.title,
      agentVersionId: node.agentVersionId,
      status: node.status,
      inputDigest: node.inputDigest,
      resultDigest: node.resultDigest,
      failureCode: node.failureCode,
      child:
        child === null
          ? null
          : {
              runId: child.runId,
              threadId: child.threadId,
              status: child.status,
              revision: child.revision,
            },
      gate:
        gate === null
          ? null
          : {
              gateRequestId: gate.gateRequestId,
              approvalPolicyId: gate.approvalPolicyId,
              inputDigest: gate.inputDigest,
            },
      output: output == null ? null : JSON.parse(output),
    };
  });
  return parseWorkflowRunSnapshotResponse(
    {
      schemaVersion: "crewon.workflow-run-snapshot.v0",
      run: publicRun(run),
      workflow: {
        name: context.workflow.name,
        description: context.workflow.description,
      },
      input: context.rootInput.value,
      execution:
        execution === null
          ? null
          : {
              revision: execution.revision,
              status: execution.status,
              cancelRequested: execution.cancelRequested,
              updatedAt: execution.updatedAt,
            },
      nodes,
    },
    run.runId,
  );
}

function publicRun(run: RunState) {
  const {
    runId,
    threadId,
    status,
    revision,
    lastSequence,
    cancelRequested,
    collaborationMode,
    workflowVersionBinding,
    goalBinding,
    outputRef,
    failure,
    createdAt,
    updatedAt,
    terminalAt,
  } = run;
  return {
    runId,
    threadId,
    status,
    revision,
    lastSequence,
    cancelRequested,
    collaborationMode,
    purpose: "workflow",
    workflowVersionBinding,
    goalBinding,
    outputRef,
    failure,
    createdAt,
    updatedAt,
    terminalAt,
    waitingApproval:
      run.waitingApproval === null
        ? null
        : { approvalId: run.waitingApproval.approvalId },
  };
}
