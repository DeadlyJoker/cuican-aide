import {
  compileWorkflowVersion,
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
  workflowVerificationInstructionV1,
} from "@crewon/domain";
import { admissionVersion } from "./workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

export function verificationTextVersion() {
  const asset = admissionVersion(),
    base = parseCompiledWorkflowVersion(
      asset.definitionJson,
      workflowAdmissionDigest,
    );
  const resultSchema = {
    type: "object" as const,
    properties: {
      result: { type: "string" as const, maxLength: 9999, enum: null },
    },
    required: ["result"],
    additionalProperties: false as const,
  };
  const nodes = base.nodes.map((node) =>
    node.kind === "verification"
      ? {
          ...node,
          instruction: workflowVerificationInstructionV1("Verify evidence"),
          inputSchema: resultSchema,
          outputSchema: resultSchema,
        }
      : { ...node, outputSchema: resultSchema },
  );
  const { contentDigest: _digest, executionOrder: _order, ...source } = base;
  const compiled = compileWorkflowVersion(
    {
      ...source,
      schemaVersion: "crewon.workflow-version-source.v0",
      nodes,
      outputSchema: resultSchema,
    },
    workflowAdmissionDigest,
  );
  return {
    ...asset,
    contentDigest: compiled.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(compiled),
  };
}
