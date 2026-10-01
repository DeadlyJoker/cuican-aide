import type { WorkItemExecutionScope } from "./durable-queue-port.ts";
import { RunStoreError } from "./run-store-port.ts";

/** A copied scheduling selector grants no execution permission or user identity. */
export function copyWorkItemExecutionScope(
  input: unknown,
): WorkItemExecutionScope {
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    invalid();
  const allowed = ["tenantId", "extensionImplementationDigest", "unboundRuns"];
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
  )
    invalid();
  const record: Record<string, unknown> = Object.create(null);
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      invalid();
    record[key] = descriptor.value;
  }
  if (
    typeof record.tenantId !== "string" ||
    record.tenantId === "" ||
    record.tenantId !== record.tenantId.trim() ||
    Buffer.byteLength(record.tenantId) > 512 ||
    /[\u0000-\u001f\u007f]/u.test(record.tenantId)
  )
    invalid();
  if (
    typeof record.extensionImplementationDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.extensionImplementationDigest)
  )
    invalid();
  if (record.unboundRuns !== "include" && record.unboundRuns !== "exclude")
    invalid();
  return Object.freeze({
    tenantId: record.tenantId,
    extensionImplementationDigest: record.extensionImplementationDigest,
    unboundRuns: record.unboundRuns,
  });
}
function invalid(): never {
  throw new RunStoreError("queue_execution_scope_invalid");
}
