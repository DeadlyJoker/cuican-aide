import { WorkflowVersionError } from "./workflow-version-error.ts";
import {
  compileWorkflowVersion,
  type CompiledWorkflowVersion,
  type WorkflowContentDigester,
  type WorkflowVersionSource,
} from "./workflow-version.ts";

export const MAX_WORKFLOW_DEFINITION_BYTES = 2 * 1024 * 1024;

/** Writes the only durable JSON representation accepted by the reader. */
export function serializeCompiledWorkflowVersion(
  version: CompiledWorkflowVersion,
): string {
  const definitionJson = canonicalJson(version);
  if (byteLength(definitionJson) > MAX_WORKFLOW_DEFINITION_BYTES) {
    throw new WorkflowVersionError("workflow_definition_too_large");
  }
  return definitionJson;
}

/** Recompiles a canonical durable definition and rejects all derived drift. */
export function parseCompiledWorkflowVersion(
  definitionJson: string,
  digester: WorkflowContentDigester,
): CompiledWorkflowVersion {
  if (
    typeof definitionJson !== "string" ||
    byteLength(definitionJson) > MAX_WORKFLOW_DEFINITION_BYTES
  ) {
    throw new WorkflowVersionError("workflow_definition_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(definitionJson);
  } catch {
    throw new WorkflowVersionError("workflow_definition_invalid");
  }
  const definition = requireObject(value);
  requireExactKeys(definition, [
    "contentDigest",
    "description",
    "entryNodeIds",
    "executionOrder",
    "inputSchema",
    "name",
    "nodes",
    "outputNodeIds",
    "outputSchema",
    "schemaVersion",
    "workflowId",
    "workflowVersionId",
  ]);
  if (
    definition.schemaVersion !== "crewon.workflow-version.v0" ||
    typeof definition.contentDigest !== "string"
  ) {
    throw new WorkflowVersionError("workflow_definition_invalid");
  }
  const compiled = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: definition.workflowId,
      workflowVersionId: definition.workflowVersionId,
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      entryNodeIds: definition.entryNodeIds,
      outputNodeIds: definition.outputNodeIds,
      nodes: definition.nodes,
    } as WorkflowVersionSource,
    digester,
    definition.contentDigest,
  );
  if (
    serializeCompiledWorkflowVersion(compiled) !== definitionJson ||
    canonicalJson(compiled) !== canonicalJson(definition)
  ) {
    throw new WorkflowVersionError("workflow_definition_invalid");
  }
  return compiled;
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new WorkflowVersionError("workflow_definition_invalid");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkflowVersionError("workflow_definition_invalid");
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expectedSorted = [...expected].sort();
  if (
    actual.length !== expectedSorted.length ||
    actual.some((key, index) => key !== expectedSorted[index])
  ) {
    throw new WorkflowVersionError("workflow_definition_invalid");
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
