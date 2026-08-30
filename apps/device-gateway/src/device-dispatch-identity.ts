import { createHash } from "node:crypto";

import {
  parseDeviceExecutionCommand,
  type DeviceExecutionCommand,
} from "@crewon/contracts";

/** Returns the stable action identity while excluding renewable lease authorization. */
export function deviceDispatchFingerprint(
  input: DeviceExecutionCommand,
): string {
  const command = parseDeviceExecutionCommand(input);
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        actionDigest: command.actionDigest,
        arguments: command.arguments,
        attemptId: command.attemptId,
        capability: command.capability,
        deviceId: command.deviceId,
        executionId: command.executionId,
        idempotencyKey: command.idempotencyKey,
        limits: command.limits,
        payloadRef: command.payloadRef,
        runId: command.runId,
        stepId: command.stepId,
        traceContext: command.traceContext,
        workspaceBindingId: command.workspaceBindingId,
      }),
      "utf8",
    )
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson(value[key]);
  }
  return sorted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
