import { parseFrozenWorkflowVersionBinding } from "./run-lifecycle.ts";
import type { FrozenWorkflowVersionBinding } from "./workflow-version.ts";

export const OFFICE_DELEGATION_LIMITS = Object.freeze({
  id: 512,
  list: 100,
});

/** Immutable Office provenance for one canonical Workflow Run. */
export type OfficeDelegation = Readonly<{
  schemaVersion: "crewon.office-delegation.v0";
  delegationId: string;
  tenantId: string;
  spaceId: string;
  officeId: string;
  officeVersionId: string;
  workflowVersionBinding: FrozenWorkflowVersionBinding;
  threadId: string;
  runId: string;
  requestedByActorId: string;
  createdAt: string;
}>;

export function parseOfficeDelegation(input: unknown): OfficeDelegation {
  const value = object(input);
  if (
    Object.keys(value).sort().join("\0") !==
    "createdAt\0delegationId\0officeId\0officeVersionId\0requestedByActorId\0runId\0schemaVersion\0spaceId\0tenantId\0threadId\0workflowVersionBinding"
  )
    invalid();
  if (value.schemaVersion !== "crewon.office-delegation.v0") invalid();
  let workflowVersionBinding: FrozenWorkflowVersionBinding;
  try {
    workflowVersionBinding = parseFrozenWorkflowVersionBinding(
      value.workflowVersionBinding,
    );
  } catch {
    invalid();
  }
  return {
    schemaVersion: value.schemaVersion,
    delegationId: id(value.delegationId),
    tenantId: id(value.tenantId),
    spaceId: id(value.spaceId),
    officeId: id(value.officeId),
    officeVersionId: id(value.officeVersionId),
    workflowVersionBinding,
    threadId: id(value.threadId),
    runId: id(value.runId),
    requestedByActorId: id(value.requestedByActorId),
    createdAt: timestamp(value.createdAt),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > OFFICE_DELEGATION_LIMITS.id ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
    invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  return value;
}

function invalid(): never {
  throw new Error("office_delegation_invalid");
}
