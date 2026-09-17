import {
  WorkflowHumanGateApplicationService,
  type WorkflowHumanGateAuthorization,
  type DecideWorkflowHumanGateCommand,
  type WorkflowExecutionState,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";
import {
  admissionActor,
  admissionVersion,
} from "./workflow-run-admission.test-support.ts";
import { cancellationChildDispatch } from "./workflow-cancellation.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

export const gateActor = {
  ...admissionActor,
  actorId: "reviewer-1",
  principalId: "reviewer-principal",
};
export const authorizeTestGate: WorkflowHumanGateAuthorization = ({
  actor,
  authority,
}) =>
  actor.actorId === gateActor.actorId &&
  actor.principalId === gateActor.principalId &&
  authority.approvalPolicyId === "review-policy"
    ? { outcome: "allow" }
    : { outcome: "deny", reasonCode: "gate-policy-denied" };
export const gateCompositionOptions = {
  dispatchChildren: cancellationChildDispatch,
  humanGates: { authorize: authorizeTestGate },
};

export function gateCommand(
  state: WorkflowExecutionState,
  nodeId: string,
  decision: "approved" | "rejected" = "approved",
): DecideWorkflowHumanGateCommand {
  const node = state.nodes.find((n) => n.nodeId === nodeId)!;
  return {
    kind: "workflowHumanGate.decide",
    runId: state.runId,
    nodeId,
    gateRequestId: node.gateRequestId!,
    inputDigest: node.inputDigest!,
    decision,
  };
}
export function sequentialGateVersion() {
  const asset = admissionVersion(),
    base = parseCompiledWorkflowVersion(
      asset.definitionJson,
      workflowAdmissionDigest,
    ),
    first = base.nodes[0]!;
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
        first,
        {
          kind: "humanGate",
          nodeId: "review",
          title: "Review",
          instruction: "Review the committed input",
          approvalPolicyId: "review-policy",
          dependsOn: [first.nodeId],
          inputSchema: first.outputSchema,
          outputSchema: first.outputSchema,
        },
        { ...base.nodes[1]!, dependsOn: ["review"] },
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
export { WorkflowHumanGateApplicationService };
