import {
  compileWorkflowVersion,
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
  workflowOutputSchema,
  type WorkflowObjectSchema,
} from "@crewon/domain";
import { admissionVersion } from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { parallelVersion } from "./workflow-run-composition.test-support.ts";

export function largeWorkflowOutputSchema(
  count = 8,
  textBytes = 7900,
): WorkflowObjectSchema {
  return {
    type: "object",
    properties: {
      topic: {
        type: "string",
        maxLength: 9999,
        enum: Array.from(
          { length: count },
          (_, index) => `${index}-${"x".repeat(textBytes - 2)}`,
        ),
      },
    },
    required: ["topic"],
    additionalProperties: false,
  };
}
export function oversizedChildVersion() {
  const asset = admissionVersion(),
    base = parseCompiledWorkflowVersion(
      asset.definitionJson,
      workflowAdmissionDigest,
    );
  const schema = largeWorkflowOutputSchema();
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
      nodes: base.nodes.map((node) =>
        node.kind === "agent"
          ? { ...node, instruction: "x".repeat(9999), outputSchema: schema }
          : { ...node, inputSchema: schema },
      ),
    },
    workflowAdmissionDigest,
  );
  return {
    ...asset,
    contentDigest: compiled.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(compiled),
  };
}

export function oversizedSiblingVersion() {
  const asset = parallelVersion(2),
    base = parseCompiledWorkflowVersion(
      asset.definitionJson,
      workflowAdmissionDigest,
    );
  const roots = base.nodes
    .filter((node) => node.kind !== "verification")
    .map((node) =>
      node.nodeId === "root-1"
        ? {
            ...node,
            instruction: "x".repeat(9999),
            outputSchema: largeWorkflowOutputSchema(),
          }
        : node,
    );
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
        ...roots,
        ...base.nodes
          .filter((node) => node.kind === "verification")
          .map((node) => ({
            ...node,
            inputSchema: workflowOutputSchema({
              nodes: roots,
              outputNodeIds: base.entryNodeIds,
            }),
          })),
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
