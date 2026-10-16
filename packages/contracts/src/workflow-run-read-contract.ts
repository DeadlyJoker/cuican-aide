import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { parseRunView } from "./run-view.ts";

export type WorkflowRunSnapshotResponse =
  components["schemas"]["WorkflowRunSnapshotResponse"];
export type WorkflowRunNodeView = components["schemas"]["WorkflowRunNodeView"];
export type WorkflowHumanGateResponse =
  components["schemas"]["WorkflowHumanGateResponse"];
export type WorkflowHumanGateMutationResponse =
  components["schemas"]["WorkflowHumanGateMutationResponse"];
export type DecideWorkflowHumanGateRequest =
  components["schemas"]["DecideWorkflowHumanGateRequest"];
export type WorkflowGateLocator = Readonly<{
  runId: string;
  nodeId: string;
  gateRequestId: string;
}>;
export const MAX_WORKFLOW_RUN_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_WORKFLOW_GATE_RESPONSE_BYTES = 128 * 1024;

function fail(): never {
  throw new ContractValidationError("workflow_response_invalid");
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  return value as Record<string, unknown>;
}
function keys(value: unknown, fields: string[]) {
  const row = object(value);
  if (Object.keys(row).sort().join() !== [...fields].sort().join()) fail();
  return row;
}
function text(value: unknown, maximum = 512, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    new TextEncoder().encode(value).byteLength > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    fail();
  return value;
}
function id(value: unknown) {
  const result = text(value);
  if (result.trim() !== result || /[\r\n\t]/u.test(result)) fail();
  return result;
}
function digest(value: unknown) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    fail();
  return value;
}
function timestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail();
  return value;
}
function integer(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail();
  return Number(value);
}
function choice(value: unknown, values: string[]) {
  if (typeof value !== "string" || !values.includes(value)) fail();
  return value;
}
export function parseWorkflowGateLocator(value: unknown): WorkflowGateLocator {
  const row = keys(dataJson(value, 4096), ["runId", "nodeId", "gateRequestId"]);
  return {
    runId: id(row.runId),
    nodeId: id(row.nodeId),
    gateRequestId: id(row.gateRequestId),
  };
}
export function parseDecideWorkflowHumanGateRequest(
  value: unknown,
): DecideWorkflowHumanGateRequest {
  const row = keys(dataJson(value, 4096), ["inputDigest", "decision"]);
  return {
    inputDigest: digest(row.inputDigest),
    decision: choice(row.decision, ["approved", "rejected"]) as
      | "approved"
      | "rejected",
  };
}

/** Copy data properties before validation/serialization; never execute caller accessors or toJSON. */
function dataJson(
  value: unknown,
  maximumBytes: number,
  input = false,
): unknown {
  let nodes = 0,
    bytes = 0;
  const path = new Set<object>();
  const measure = (value: string, maximum = maximumBytes) => {
    if (value.length > maximum) fail();
    const size = new TextEncoder().encode(value).byteLength;
    if (size > maximum || (bytes += size) > maximumBytes) fail();
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > (input ? 1024 : 300000) || depth > (input ? 8 : 40)) fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail();
      return value;
    }
    if (typeof value === "string") {
      measure(value, input ? 8192 : maximumBytes);
      return value;
    }
    if (!value || typeof value !== "object" || path.has(value)) fail();
    path.add(value);
    const names = Reflect.ownKeys(value);
    let result: unknown;
    if (Array.isArray(value)) {
      if (
        value.length > (input ? 256 : 32768) ||
        names.length !== value.length + 1
      )
        fail();
      result = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          fail();
        return visit(descriptor.value, depth + 1);
      });
    } else {
      object(value);
      if (names.length > (input ? 256 : 32768)) fail();
      result = Object.fromEntries(
        names.map((key) => {
          if (typeof key !== "string") fail();
          measure(key, 8192);
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
            fail();
          return [key, visit(descriptor.value, depth + 1)];
        }),
      );
    }
    path.delete(value);
    return result;
  };
  const result = visit(value, 0);
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > maximumBytes
  )
    fail();
  return result;
}
export function parseWorkflowReadValue(
  value: unknown,
  mode: "input" | "output",
): components["schemas"]["WorkflowInput"] {
  return dataJson(
    value,
    32768,
    mode === "input",
  ) as components["schemas"]["WorkflowInput"];
}

function authority(value: unknown, locator: WorkflowGateLocator) {
  const row = keys(value, [
    "tenantId",
    "spaceId",
    "runId",
    "nodeId",
    "binding",
    "claimId",
    "gateRequestId",
    "approvalPolicyId",
    "inputDigest",
  ]);
  for (const field of [
    "tenantId",
    "spaceId",
    "runId",
    "nodeId",
    "claimId",
    "gateRequestId",
    "approvalPolicyId",
  ])
    id(row[field]);
  if (
    row.runId !== locator.runId ||
    row.nodeId !== locator.nodeId ||
    row.gateRequestId !== locator.gateRequestId
  )
    fail();
  const binding = keys(row.binding, [
    "workflowId",
    "workflowVersionId",
    "contentDigest",
  ]);
  id(binding.workflowId);
  id(binding.workflowVersionId);
  digest(binding.contentDigest);
  digest(row.inputDigest);
  return row as components["schemas"]["WorkflowHumanGateAuthorityView"];
}
function decision(value: unknown, locator: WorkflowGateLocator) {
  const row = keys(value, ["authority", "actor", "outcome", "decidedAt"]);
  const scope = authority(row.authority, locator);
  const actor = keys(row.actor, [
    "tenantId",
    "spaceId",
    "actorId",
    "principalId",
  ]);
  Object.values(actor).forEach((value) => id(value));
  if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
    fail();
  choice(row.outcome, ["approved", "rejected"]);
  timestamp(row.decidedAt);
  return row as WorkflowHumanGateMutationResponse["decision"];
}
export function parseWorkflowHumanGateResponse(
  value: unknown,
  locatorInput: WorkflowGateLocator,
): WorkflowHumanGateResponse {
  const locator = parseWorkflowGateLocator(locatorInput);
  const row = keys(dataJson(value, MAX_WORKFLOW_GATE_RESPONSE_BYTES), [
    "schemaVersion",
    "authority",
    "title",
    "instruction",
    "input",
    "status",
    "decision",
  ]);
  if (row.schemaVersion !== "crewon.workflow-human-gate.v0") fail();
  const scope = authority(row.authority, locator);
  text(row.title);
  text(row.instruction, 9999, true);
  choice(row.status, ["waitingHuman", "completed", "failed", "canceled"]);
  const input = parseWorkflowReadValue(row.input, "output");
  if (row.decision !== null) {
    const chosen = decision(row.decision, locator);
    if (
      Object.keys(scope).some((key) =>
        key === "binding"
          ? Object.keys(scope.binding).some(
              (field) =>
                chosen.authority.binding[
                  field as keyof typeof scope.binding
                ] !== scope.binding[field as keyof typeof scope.binding],
            )
          : chosen.authority[key as keyof typeof scope] !==
            scope[key as keyof typeof scope],
      ) ||
      row.status !== (chosen.outcome === "approved" ? "completed" : "failed")
    )
      fail();
  } else if (row.status !== "waitingHuman" && row.status !== "canceled") fail();
  const result = { ...row, input } as WorkflowHumanGateResponse;
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_WORKFLOW_GATE_RESPONSE_BYTES
  )
    fail();
  return structuredClone(result);
}
export function parseWorkflowHumanGateMutationResponse(
  value: unknown,
  locatorInput: WorkflowGateLocator,
  command: DecideWorkflowHumanGateRequest,
): WorkflowHumanGateMutationResponse {
  const locator = parseWorkflowGateLocator(locatorInput);
  const expected = parseDecideWorkflowHumanGateRequest(command);
  const row = keys(dataJson(value, MAX_WORKFLOW_GATE_RESPONSE_BYTES), [
    "disposition",
    "decision",
  ]);
  choice(row.disposition, ["committed", "replayed"]);
  const chosen = decision(row.decision, locator);
  if (
    chosen.authority.inputDigest !== expected.inputDigest ||
    chosen.outcome !== expected.decision ||
    new TextEncoder().encode(JSON.stringify(row)).byteLength >
      MAX_WORKFLOW_GATE_RESPONSE_BYTES
  )
    fail();
  return structuredClone(row) as WorkflowHumanGateMutationResponse;
}

const nodeStatuses = [
  "pending",
  "running",
  "waitingHuman",
  "completed",
  "failed",
  "canceled",
  "unknown",
];
const terminal = ["completed", "failed", "canceled"];
export function parseWorkflowRunSnapshotResponse(
  value: unknown,
  runId: string,
): WorkflowRunSnapshotResponse {
  id(runId);
  const row = keys(dataJson(value, MAX_WORKFLOW_RUN_SNAPSHOT_BYTES), [
    "schemaVersion",
    "run",
    "workflow",
    "input",
    "execution",
    "nodes",
  ]);
  if (row.schemaVersion !== "crewon.workflow-run-snapshot.v0") fail();
  const run = parseRunView(row.run);
  if (
    run.runId !== runId ||
    run.purpose !== "workflow" ||
    run.workflowVersionBinding === null
  )
    fail();
  const workflow = keys(row.workflow, ["name", "description"]);
  text(workflow.name);
  text(workflow.description, 8192, true);
  const input = parseWorkflowReadValue(row.input, "input");
  if (
    !Array.isArray(row.nodes) ||
    row.nodes.length < 1 ||
    row.nodes.length > 64
  )
    fail();
  const seen = new Set<string>();
  const children = new Set<string>();
  const gates = new Set<string>();
  const nodes = row.nodes.map((raw) => {
    const node = keys(raw, [
      "nodeId",
      "kind",
      "title",
      "agentVersionId",
      "status",
      "inputDigest",
      "resultDigest",
      "failureCode",
      "child",
      "gate",
      "output",
    ]);
    const nodeId = id(node.nodeId);
    if (seen.has(nodeId)) fail();
    seen.add(nodeId);
    choice(node.kind, ["agent", "humanGate", "verification"]);
    text(node.title);
    choice(node.status, nodeStatuses);
    if (node.inputDigest !== null) digest(node.inputDigest);
    if (
      (node.status === "pending" && node.inputDigest !== null) ||
      (!["pending", "canceled"].includes(String(node.status)) &&
        node.inputDigest === null)
    )
      fail();
    if (
      (node.kind === "humanGate" &&
        ["running", "unknown"].includes(String(node.status))) ||
      (node.kind !== "humanGate" && node.status === "waitingHuman")
    )
      fail();
    if (node.resultDigest !== null) digest(node.resultDigest);
    if (node.failureCode !== null) text(node.failureCode, 128);
    if (node.agentVersionId !== null) id(node.agentVersionId);
    if ((node.kind === "humanGate") !== (node.agentVersionId === null)) fail();
    if (
      node.status === "completed"
        ? node.resultDigest === null || node.failureCode !== null
        : node.resultDigest !== null || node.output !== null
    )
      fail();
    if (
      node.status === "failed"
        ? node.failureCode === null
        : node.failureCode !== null
    )
      fail();
    if (node.child !== null) {
      const child = keys(node.child, [
        "runId",
        "threadId",
        "status",
        "revision",
      ]);
      const childId = id(child.runId);
      id(child.threadId);
      integer(child.revision);
      choice(child.status, [
        "queued",
        "running",
        "waitingApproval",
        "suspended",
        "reconciling",
        ...terminal,
      ]);
      if (
        childId === runId ||
        children.has(childId) ||
        node.kind === "humanGate" ||
        node.status === "pending" ||
        (terminal.includes(String(node.status)) &&
          !terminal.includes(String(child.status)))
      )
        fail();
      if (node.status === "completed" && child.status !== "completed") fail();
      children.add(childId);
    } else if (
      node.kind !== "humanGate" &&
      ["running", "unknown", "completed", "failed"].includes(
        String(node.status),
      )
    )
      fail();
    if (node.gate !== null) {
      const gate = keys(node.gate, [
        "gateRequestId",
        "approvalPolicyId",
        "inputDigest",
      ]);
      const gateId = id(gate.gateRequestId);
      id(gate.approvalPolicyId);
      digest(gate.inputDigest);
      if (
        gates.has(gateId) ||
        node.kind !== "humanGate" ||
        node.status === "pending" ||
        gate.inputDigest !== node.inputDigest
      )
        fail();
      gates.add(gateId);
    } else if (
      node.kind === "humanGate" &&
      ["waitingHuman", "completed", "failed"].includes(String(node.status))
    )
      fail();
    return {
      ...node,
      output: parseWorkflowReadValue(node.output, "output"),
    } as WorkflowRunNodeView;
  });
  if (row.execution === null) {
    if (
      terminal.includes(run.status) ||
      nodes.some(
        (node) =>
          node.status !== "pending" ||
          node.inputDigest !== null ||
          node.child !== null ||
          node.gate !== null,
      )
    )
      fail();
  } else {
    const execution = keys(row.execution, [
      "revision",
      "status",
      "cancelRequested",
      "updatedAt",
    ]);
    integer(execution.revision);
    choice(execution.status, ["running", "waitingHuman", ...terminal]);
    timestamp(execution.updatedAt);
    if (
      typeof execution.cancelRequested !== "boolean" ||
      (execution.cancelRequested && !run.cancelRequested)
    )
      fail();
    const active = nodes.some(
      (node) => node.status === "running" || node.status === "unknown",
    );
    const projected =
      execution.cancelRequested && !active
        ? "canceled"
        : nodes.some((node) => node.status === "failed")
          ? "failed"
          : nodes.every((node) => node.status === "completed")
            ? "completed"
            : nodes.some((node) => node.status === "waitingHuman") && !active
              ? "waitingHuman"
              : "running";
    if (execution.status !== projected) fail();
    if (
      terminal.includes(run.status) &&
      nodes.some((node) =>
        ["pending", "running", "unknown", "waitingHuman"].includes(
          String(node.status),
        ),
      )
    )
      fail();
    if (
      (run.status === "completed" && execution.status !== "completed") ||
      (run.status === "canceled" && execution.status !== "canceled")
    )
      fail();
  }
  const result = { ...row, run, input, nodes };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_WORKFLOW_RUN_SNAPSHOT_BYTES
  )
    fail();
  return structuredClone(result) as WorkflowRunSnapshotResponse;
}
