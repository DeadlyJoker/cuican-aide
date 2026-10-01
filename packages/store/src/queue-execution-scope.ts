import {
  RunStoreError,
  copyWorkItemExecutionScope,
  type QueueClaimInput,
} from "@crewon/application";
import { validateQueueClaim } from "./store-invariants.ts";

/** Capture the opt-in selector before asynchronous storage access, without invoking descriptors. */
export function copyQueueClaim(
  input: QueueClaimInput,
  kind: "outbox" | "workItem",
): QueueClaimInput {
  const descriptor = Object.getOwnPropertyDescriptor(input, "executionScope");
  if (descriptor !== undefined && !("value" in descriptor)) invalid();
  if (descriptor === undefined && "executionScope" in input) invalid();
  if (descriptor?.value === undefined) {
    return input;
  }
  if (kind === "outbox")
    throw new RunStoreError("queue_execution_scope_forbidden");
  const claim = dataRecord(input, [
    "ownerId",
    "leaseId",
    "leaseDurationMs",
    "executionScope",
  ]);
  const scope = copyWorkItemExecutionScope(claim.executionScope);
  const copied: QueueClaimInput = Object.freeze({
    ownerId: claim.ownerId as string,
    leaseId: claim.leaseId as string,
    leaseDurationMs: claim.leaseDurationMs as number,
    executionScope: scope,
  });
  validateQueueClaim(copied);
  return copied;
}

/** Trusted identifiers and placeholders only; selector values remain bound SQL parameters. */
export function workItemExecutionScopeSql(input: {
  claim: QueueClaimInput;
  queueTable: string;
  extensionTablePrefix: string;
  tenantParameter: string;
  digestParameter: string;
  targetsParameter: string;
  dialect: "sqlite" | "postgres";
}): string {
  const scope = input.claim.executionScope;
  if (scope === undefined) return "";
  const bindings = `${input.extensionTablePrefix}extension_run_bindings`;
  const configurations = `${input.extensionTablePrefix}extension_configurations`;
  const identity = `b.tenant_id = ${input.queueTable}.tenant_id AND b.run_id = ${input.queueTable}.run_id`;
  const digest =
    input.dialect === "sqlite"
      ? "json_extract(c.configuration_json, '$.implementationDigest')"
      : "c.configuration_json->>'implementationDigest'";
  const targets =
    scope.extensionTargets === undefined
      ? ""
      : input.dialect === "postgres"
        ? ` AND EXISTS (SELECT 1 FROM jsonb_array_elements(${input.targetsParameter}::jsonb) prepared
            WHERE b.binding_json->'target' = prepared.value)`
        : sqliteTargetsPredicate(input.targetsParameter);
  return ` AND tenant_id = ${input.tenantParameter} AND (
    EXISTS (SELECT 1 FROM ${bindings} b JOIN ${configurations} c
      ON c.tenant_id=b.tenant_id AND c.space_id=b.space_id AND c.plugin_id=b.plugin_id AND c.revision=b.configuration_revision
      WHERE ${identity} AND ${digest} = ${input.digestParameter}${targets})
    ${scope.unboundRuns === "include" ? `OR NOT EXISTS (SELECT 1 FROM ${bindings} b WHERE ${identity})` : ""}
  )`;
}

/** Object order is irrelevant; missing/extra fields and SQL-null vs JSON-null stay distinct. */
function sqliteTargetsPredicate(parameter: string): string {
  const fields = [
    "executionAuthority",
    "agentVersionId",
    "agentVersionContentDigest",
    "materializationDigest",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
  ];
  const matches = fields.map(
    (field) =>
      `json_type(b.binding_json, '$.target.${field}') = 'text' AND json_extract(b.binding_json, '$.target.${field}') = json_extract(prepared.value, '$.${field}')`,
  );
  return ` AND EXISTS (SELECT 1 FROM json_each(${parameter}) prepared
    WHERE json_type(b.binding_json, '$.target') = 'object'
      AND (SELECT COUNT(*) FROM json_each(b.binding_json, '$.target')) = 8
      AND ${matches.join(" AND ")}
      AND json_type(b.binding_json, '$.target.workspaceBindingId') = json_type(prepared.value, '$.workspaceBindingId')
      AND json_extract(b.binding_json, '$.target.workspaceBindingId') IS json_extract(prepared.value, '$.workspaceBindingId'))`;
}

function dataRecord(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function invalid(): never {
  throw new RunStoreError("queue_execution_scope_invalid");
}
