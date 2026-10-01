import {
  extensionCanonicalJson,
  parseExtensionExecutionTarget,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
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
  const required = ["tenantId", "extensionImplementationDigest", "unboundRuns"];
  const allowed = [...required, "extensionTargets"];
  const keys = Reflect.ownKeys(input);
  if (
    (keys.length !== required.length && keys.length !== allowed.length) ||
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
  )
    invalid();
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
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
    ...(Object.hasOwn(record, "extensionTargets")
      ? { extensionTargets: copyTargets(record.extensionTargets) }
      : {}),
  });
}

function copyTargets(input: unknown): readonly ExtensionExecutionTarget[] {
  if (!Array.isArray(input) || input.length > 32) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length + 1 || !keys.includes("length")) invalid();
  const targets: ExtensionExecutionTarget[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    let target: ExtensionExecutionTarget;
    try {
      target = parseExtensionExecutionTarget(descriptor.value);
    } catch {
      invalid();
    }
    const identity = extensionCanonicalJson(target);
    if (identities.has(identity)) invalid();
    identities.add(identity);
    targets.push(target);
  }
  return Object.freeze(targets);
}
function invalid(): never {
  throw new RunStoreError("queue_execution_scope_invalid");
}
