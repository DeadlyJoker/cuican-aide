import type { WorkItemClaim } from "@crewon/application";
import type { ToolExecutionReceiptState } from "@crewon/domain";
import {
  validateToolExecutionCommand,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";

export type WorkerToolDispatchMethod = "execute" | "reconcile" | "cancel";
type Invocation = Readonly<{
  command: ToolExecutionCommand;
  method: WorkerToolDispatchMethod;
  signal: AbortSignal;
}>;
export type WorkerToolDispatchIdentity = Readonly<{
  tenantId: string;
  runId: string;
  receiptId: string;
  executionId: string;
  actionDigest: string;
  workItemId: string;
  leaseId: string;
  leaseEpoch: number;
}>;
type Grant = {
  live: boolean;
  method: WorkerToolDispatchMethod;
  signal: AbortSignal;
  commandDigest: string;
  effect: ToolExecutionCommand["actionIntent"]["effect"];
  recovery: ToolExecutionCommand["actionIntent"]["recovery"];
  expiresAt: number;
  identity: WorkerToolDispatchIdentity;
  ownerId: string;
  receipt: ToolExecutionReceiptState;
  assertCurrent(): WorkItemClaim;
};
const grants = new WeakMap<ToolExecutionCommand, Grant>();

/** Worker-only: call after durable dispatch/recovery and current queue confirmation. */
export async function withWorkerToolDispatch<T>(
  input: Invocation &
    Readonly<{
      receipt: ToolExecutionReceiptState;
      assertCurrent(): WorkItemClaim;
    }>,
  delegate: () => Promise<T>,
): Promise<T> {
  const { command, receipt, method, signal } = input;
  if (grants.has(command)) denied();
  validateToolExecutionCommand(command);
  if (
    (receipt.status !== "dispatched" && receipt.status !== "unknownOutcome") ||
    (method === "execute" && receipt.status !== "dispatched") ||
    receipt.actionIntent === null ||
    command.runId !== receipt.runId ||
    command.executionId !== receipt.executionId ||
    command.actionDigest !== receipt.actionDigest ||
    command.idempotencyKey !== receipt.idempotencyKey ||
    command.executionLease.workItemId !== receipt.workItemId ||
    command.executionLease.stepId !== receipt.stepId ||
    command.executionLease.attemptId !== receipt.attemptId ||
    command.segmentId !== receipt.call.segmentId ||
    command.callId !== receipt.call.callId ||
    command.kind !== receipt.call.kind ||
    command.name !== receipt.call.name ||
    command.actionIntent.tool.inputDigest !== receipt.call.inputDigest ||
    fingerprint(command.actionIntent) !== fingerprint(receipt.actionIntent)
  )
    denied();
  const claim = input.assertCurrent();
  const grant: Grant = {
    live: true,
    method,
    signal,
    commandDigest: fingerprint(command),
    effect: command.actionIntent.effect,
    recovery: command.actionIntent.recovery,
    expiresAt: Date.parse(command.executionLease.expiresAt),
    ownerId: claim.lease.ownerId,
    receipt,
    identity: Object.freeze({
      tenantId: receipt.tenantId,
      runId: receipt.runId,
      receiptId: receipt.receiptId,
      executionId: receipt.executionId,
      actionDigest: receipt.actionDigest,
      workItemId: receipt.workItemId,
      leaseId: command.executionLease.leaseId,
      leaseEpoch: command.executionLease.leaseEpoch,
    }),
    assertCurrent: input.assertCurrent,
  };
  checkClaim(grant, claim);
  signal.throwIfAborted();
  grants.set(command, grant);
  try {
    return await delegate();
  } finally {
    grant.live = false;
    grants.delete(command);
  }
}

/** Adapter-only alias: checked DTO identity is authorized only while the real delegate drains. */
export async function withCheckedWorkerToolDispatch<T>(
  input: Invocation & Readonly<{ originalCommand: ToolExecutionCommand }>,
  delegate: () => Promise<T>,
): Promise<T> {
  const original = { ...input, command: input.originalCommand };
  assertWorkerToolDispatch(original);
  const grant = grants.get(input.originalCommand)!;
  if (
    fingerprint(input.command) !== grant.commandDigest ||
    grants.has(input.command)
  )
    denied();
  grants.set(input.command, grant);
  try {
    return await delegate();
  } finally {
    grants.delete(input.command);
  }
}

/** Fresh authority for a new read/network operation, including checks after awaits/DNS. */
export function assertWorkerToolDispatch(
  input: Invocation,
): WorkerToolDispatchIdentity {
  const identity = assertWorkerToolDispatchIdentity(input);
  const grant = grants.get(input.command)!;
  input.signal.throwIfAborted();
  checkClaim(grant, grant.assertCurrent());
  return identity;
}

/** Host-only evidence: the live issuer's receipt and fresh claim, never plugin-supplied JSON. */
export function assertWorkerToolDispatchEvidence(input: Invocation): Readonly<{
  identity: WorkerToolDispatchIdentity;
  receipt: ToolExecutionReceiptState;
  claim: WorkItemClaim;
}> {
  const identity = assertWorkerToolDispatchIdentity(input);
  const grant = grants.get(input.command)!;
  input.signal.throwIfAborted();
  const claim = grant.assertCurrent();
  checkClaim(grant, claim);
  return Object.freeze({ identity, receipt: grant.receipt, claim });
}

/** Local accepted-evidence CAS only; this deliberately does not authorize new external I/O. */
export function assertWorkerToolDispatchIdentity(
  input: Invocation,
): WorkerToolDispatchIdentity {
  const grant = grants.get(input.command);
  if (
    grant === undefined ||
    !grant.live ||
    input.signal !== grant.signal ||
    !methodAllowed(grant, input.method) ||
    fingerprint(input.command) !== grant.commandDigest
  )
    denied();
  return grant.identity;
}

function methodAllowed(
  grant: Grant,
  method: WorkerToolDispatchMethod,
): boolean {
  return (
    method === grant.method ||
    (grant.method === "reconcile" &&
      method === "execute" &&
      grant.effect === "readOnly" &&
      grant.recovery === "replaySafe")
  );
}

function checkClaim(grant: Grant, claim: WorkItemClaim): void {
  if (
    claim.workItem.tenantId !== grant.identity.tenantId ||
    claim.workItem.runId !== grant.identity.runId ||
    claim.workItem.workItemId !== grant.identity.workItemId ||
    claim.lease.ownerId !== grant.ownerId ||
    claim.lease.leaseId !== grant.identity.leaseId ||
    claim.lease.epoch !== grant.identity.leaseEpoch ||
    !Number.isFinite(grant.expiresAt) ||
    !Number.isFinite(Date.parse(claim.lease.expiresAt)) ||
    Date.parse(claim.lease.expiresAt) < grant.expiresAt
  )
    denied();
}

// Descriptor-only comparison never executes getters, toJSON, or other plugin hooks.
function fingerprint(input: unknown, ancestors = new Set<object>()): string {
  if (input === null || typeof input === "string" || typeof input === "boolean")
    return JSON.stringify(input);
  if (typeof input === "number" && Number.isFinite(input))
    return JSON.stringify(input);
  if (typeof input !== "object" || ancestors.has(input)) denied();
  const prototype = Object.getPrototypeOf(input);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !Array.isArray(input)
  )
    denied();
  ancestors.add(input);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some((key) => typeof key !== "string")) denied();
    if (Array.isArray(input)) {
      const parts: string[] = [];
      for (let index = 0; index < input.length; index++) {
        const property = descriptors[String(index)];
        if (property === undefined || !("value" in property)) denied();
        parts.push(fingerprint(property.value, ancestors));
      }
      if (Object.keys(descriptors).length !== input.length + 1) denied();
      return `[${parts.join(",")}]`;
    }
    return `{${Object.keys(descriptors)
      .sort()
      .map((key) => {
        const property = descriptors[key]!;
        if (!("value" in property) || !property.enumerable) denied();
        return `${JSON.stringify(key)}:${fingerprint(property.value, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(input);
  }
}

function denied(): never {
  throw new Error("plugin_tool_dispatch_authority_denied");
}
