import type { PublishWorkflowVersionRequest } from "@crewon/contracts";
import { workflowVerificationInstructionV1 as verificationContractV1Instruction } from "@crewon/domain/workflow-verification";
const promptSchema = {
  type: "object" as const,
  properties: {
    prompt: { type: "string" as const, maxLength: 9_999, enum: null },
  },
  required: ["prompt"],
  additionalProperties: false as const,
};
const resultSchema = {
  type: "object" as const,
  properties: {
    result: { type: "string" as const, maxLength: 9_999, enum: null },
  },
  required: ["result"],
  additionalProperties: false as const,
};

export type ControlWorkflowCreateInput = Readonly<{
  title: string;
  description: string;
  nodes: readonly (
    | Readonly<{
        type: "agent" | "verification";
        title: string;
        instruction: string;
        agentVersionId: string;
      }>
    | Readonly<{
        type: "humanGate";
        title: string;
        instruction: string;
      }>
  )[];
}>;

export function controlWorkflowDefinition(
  input: ControlWorkflowCreateInput,
): PublishWorkflowVersionRequest {
  validateCreateInput(input);
  const workflowId = `workflow-${crypto.randomUUID()}`;
  const workflowVersionId = `workflow-version-${crypto.randomUUID()}`;
  let upstreamSchema: typeof promptSchema | typeof resultSchema = promptSchema;
  const nodes = input.nodes.map((node, index) => {
    const nodeId = `node-${String(index + 1).padStart(2, "0")}`;
    const dependsOn =
      index === 0 ? [] : [`node-${String(index).padStart(2, "0")}`];
    if (node.type === "humanGate") {
      return {
        nodeId,
        kind: "humanGate" as const,
        title: node.title,
        instruction: node.instruction,
        dependsOn,
        inputSchema: upstreamSchema,
        outputSchema: upstreamSchema,
        approvalPolicyId: "control-workflow-user-gate-v1",
      };
    }
    const definition =
      node.type === "verification"
        ? {
            nodeId,
            kind: "verification" as const,
            title: node.title,
            instruction: verificationContractV1Instruction(node.instruction),
            dependsOn,
            inputSchema: upstreamSchema,
            outputSchema: resultSchema,
            verifierAgentVersionId: node.agentVersionId,
          }
        : {
            nodeId,
            kind: "agent" as const,
            title: node.title,
            instruction: node.instruction,
            dependsOn,
            inputSchema: upstreamSchema,
            outputSchema: resultSchema,
            agentVersionId: node.agentVersionId,
          };
    upstreamSchema = resultSchema;
    return definition;
  });
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId,
    workflowVersionId,
    name: input.title.trim(),
    description: input.description.trim(),
    inputSchema: promptSchema,
    outputSchema: upstreamSchema,
    entryNodeIds: [nodes[0]!.nodeId],
    outputNodeIds: [nodes.at(-1)!.nodeId],
    nodes,
  };
}
function validateCreateInput(input: ControlWorkflowCreateInput): void {
  if (
    !input.title.trim() ||
    !input.description.trim() ||
    input.nodes.length === 0 ||
    input.nodes.length > 32 ||
    input.nodes.some(
      (node) =>
        !node.title.trim() ||
        !node.instruction.trim() ||
        (node.type !== "humanGate" && !node.agentVersionId.trim()),
    )
  ) {
    throw new Error("control_workflow_definition_invalid");
  }
  const output = input.nodes.at(-1);
  if (
    output?.type !== "verification" ||
    input.nodes.some(
      (node, index) =>
        index < input.nodes.length - 1 &&
        node.type === "agent" &&
        node.agentVersionId === output.agentVersionId,
    )
  ) {
    throw new Error("control_workflow_independent_verification_required");
  }
}
