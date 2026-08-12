import {
  MAX_WORKFLOW_VALUE_BYTES,
  validateWorkflowSchemaValue,
  type WorkflowSchemaValue,
} from "./workflow-schema-value.ts";
import type {
  CompiledWorkflowVersion,
  WorkflowContentDigester,
  WorkflowNodeDefinition,
} from "./workflow-version.ts";
import { WorkflowVersionError } from "./workflow-version-error.ts";
import type { ModelDispatchTerminalOutcome } from "./model-dispatch-receipt.ts";

/** Immutable WorkflowVersion and node identity that authorizes one output value. */
export type WorkflowNodeValueAuthority = Readonly<{
  workflowId: string;
  workflowVersionId: string;
  workflowContentDigest: string;
  nodeId: string;
  outputSchemaDigest: string;
}>;

/** Content-addressed reference to a validated canonical Workflow node value. */
export type WorkflowNodeValueRef = Readonly<{
  authority: WorkflowNodeValueAuthority;
  valueDigest: string;
}>;

export type WorkflowNodeTerminalEvidence =
  | Readonly<{
      schemaVersion: "crewon.workflow-node-terminal.v0";
      status: "completed";
      valueRef: WorkflowNodeValueRef;
      canonicalValueJson: string;
      value: WorkflowSchemaValue;
    }>
  | Readonly<{
      schemaVersion: "crewon.workflow-node-terminal.v0";
      status: "failed";
      authority: WorkflowNodeValueAuthority;
      certainty: "notSent" | "responseObserved";
      failureCode: string;
    }>
  | Readonly<{
      schemaVersion: "crewon.workflow-node-terminal.v0";
      status: "canceled";
      authority: WorkflowNodeValueAuthority;
      certainty: "notSent" | "responseObserved";
    }>;

export type WorkflowNodeTerminalOutcome =
  | Readonly<{ status: "completed"; value: WorkflowSchemaValue }>
  | Readonly<{
      status: "failed";
      certainty: "notSent" | "responseObserved";
      failureCode: string;
    }>
  | Readonly<{
      status: "canceled";
      certainty: "notSent" | "responseObserved";
    }>;

/** Creates the single bounded terminal evidence value for an exact frozen node. */
export function createWorkflowNodeTerminalEvidence(input: {
  workflow: CompiledWorkflowVersion;
  nodeId: string;
  outcome: WorkflowNodeTerminalOutcome;
  digester: WorkflowContentDigester;
}): WorkflowNodeTerminalEvidence {
  const node = requireNode(input.workflow, input.nodeId);
  const authority = valueAuthority(input.workflow, node, input.digester);
  if (input.outcome.status === "completed") {
    const value = validateWorkflowSchemaValue(
      input.outcome.value,
      node.outputSchema,
    );
    const canonicalValueJson = canonicalJson(value);
    if (byteLength(canonicalValueJson) > MAX_WORKFLOW_VALUE_BYTES) invalid();
    const valueDigest = digest(input.digester, canonicalValueJson);
    return deepFreeze({
      schemaVersion: "crewon.workflow-node-terminal.v0",
      status: "completed",
      valueRef: { authority, valueDigest },
      canonicalValueJson,
      value,
    });
  }
  if (input.outcome.status === "failed") {
    requireFailureCode(input.outcome.failureCode);
    return deepFreeze({
      schemaVersion: "crewon.workflow-node-terminal.v0",
      status: "failed",
      authority,
      certainty: requireCertainty(input.outcome.certainty),
      failureCode: input.outcome.failureCode,
    });
  }
  return deepFreeze({
    schemaVersion: "crewon.workflow-node-terminal.v0",
    status: "canceled",
    authority,
    certainty: requireCertainty(input.outcome.certainty),
  });
}

/** Revalidates persisted evidence, including exact shape, authority, schema and digests. */
export function validateWorkflowNodeTerminalEvidence(input: {
  workflow: CompiledWorkflowVersion;
  nodeId: string;
  evidence: unknown;
  digester: WorkflowContentDigester;
}): WorkflowNodeTerminalEvidence {
  const record = exactRecord(input.evidence);
  const status = record.status;
  let outcome: WorkflowNodeTerminalOutcome;
  if (status === "completed") {
    exactKeys(record, [
      "canonicalValueJson",
      "schemaVersion",
      "status",
      "value",
      "valueRef",
    ]);
    const valueRef = exactRecord(record.valueRef);
    exactKeys(valueRef, ["authority", "valueDigest"]);
    outcome = { status, value: record.value as WorkflowSchemaValue };
  } else if (status === "failed") {
    exactKeys(record, [
      "authority",
      "certainty",
      "failureCode",
      "schemaVersion",
      "status",
    ]);
    outcome = {
      status,
      certainty: requireCertainty(record.certainty),
      failureCode: requireFailureCode(record.failureCode),
    };
  } else if (status === "canceled") {
    exactKeys(record, ["authority", "certainty", "schemaVersion", "status"]);
    outcome = { status, certainty: requireCertainty(record.certainty) };
  } else invalid();
  if (record.schemaVersion !== "crewon.workflow-node-terminal.v0") invalid();
  const expected = createWorkflowNodeTerminalEvidence({ ...input, outcome });
  if (canonicalJson(record) !== canonicalJson(expected)) invalid();
  return expected;
}

/** Requires provider dispatch terminal evidence to describe the same node outcome. */
export function validateWorkflowDispatchTerminalCorrelation(input: {
  dispatch: ModelDispatchTerminalOutcome;
  evidence: WorkflowNodeTerminalEvidence;
}): void {
  const { dispatch, evidence } = input;
  if (
    dispatch.kind !== evidence.status ||
    (evidence.status === "completed"
      ? dispatch.code !== null || dispatch.certainty !== "responseObserved"
      : dispatch.certainty !== evidence.certainty ||
        (evidence.status === "failed"
          ? dispatch.code !== evidence.failureCode
          : dispatch.code === null || dispatch.code.trim().length === 0))
  ) {
    invalid();
  }
}

function valueAuthority(
  workflow: CompiledWorkflowVersion,
  node: WorkflowNodeDefinition,
  digester: WorkflowContentDigester,
): WorkflowNodeValueAuthority {
  return {
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    workflowContentDigest: workflow.contentDigest,
    nodeId: node.nodeId,
    outputSchemaDigest: digest(digester, canonicalJson(node.outputSchema)),
  };
}

function requireNode(
  workflow: CompiledWorkflowVersion,
  nodeId: string,
): WorkflowNodeDefinition {
  const node = workflow.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) invalid();
  return node;
}

function requireCertainty(value: unknown): "notSent" | "responseObserved" {
  if (value !== "notSent" && value !== "responseObserved") invalid();
  return value;
}

function requireFailureCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  )
    invalid();
  return value;
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  )
    invalid();
}

function digest(digester: WorkflowContentDigester, value: string): string {
  const result = digester.sha256(value);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) invalid();
  return result;
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(): never {
  throw new WorkflowVersionError("workflow_node_terminal_evidence_invalid");
}
