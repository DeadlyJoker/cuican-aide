import {
  parseDeviceExecutionCommand,
  parseDeviceGatewayDispatchResolution,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import { deviceDispatchFingerprint } from "./device-dispatch-identity.ts";
import { InMemoryDeviceExecutionKindAuthority } from "./device-execution-kind-authority.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

export type DeviceDispatchAuthorityRecord = Readonly<{
  executionId: string;
  fingerprint: string;
  command: DeviceExecutionCommand;
  resolution: DeviceGatewayDispatchResolution | null;
  createdAt: string;
  updatedAt: string;
}>;

export type PrepareDeviceDispatchResult = Readonly<{
  outcome: "created" | "existing";
  record: DeviceDispatchAuthorityRecord;
}>;

/** Owns cross-process Device dispatch idempotency and terminal receipt replay. */
export interface DeviceDispatchStorePort {
  ready(): Promise<void>;
  prepare(
    command: DeviceExecutionCommand,
    preparedAt: string,
  ): Promise<PrepareDeviceDispatchResult>;
  complete(
    command: DeviceExecutionCommand,
    resolution: DeviceGatewayDispatchResolution,
    completedAt: string,
  ): Promise<DeviceDispatchAuthorityRecord>;
  load(executionId: string): Promise<DeviceDispatchAuthorityRecord | null>;
  close(): Promise<void>;
}

export class InMemoryDeviceDispatchStore implements DeviceDispatchStorePort {
  readonly #records = new Map<string, DeviceDispatchAuthorityRecord>();
  readonly #executionKinds: InMemoryDeviceExecutionKindAuthority;
  #closed = false;

  constructor(
    executionKinds: InMemoryDeviceExecutionKindAuthority = new InMemoryDeviceExecutionKindAuthority(),
  ) {
    this.#executionKinds = executionKinds;
  }

  async ready(): Promise<void> {
    this.#assertOpen();
  }

  async prepare(
    input: DeviceExecutionCommand,
    preparedAt: string,
  ): Promise<PrepareDeviceDispatchResult> {
    this.#assertOpen();
    const command = parseDeviceExecutionCommand(input);
    requireTimestamp(preparedAt);
    const fingerprint = deviceDispatchFingerprint(command);
    const prior = this.#records.get(command.executionId);
    if (prior !== undefined) {
      if (this.#executionKinds.kind(command.executionId) !== "tool") {
        throw new DeviceGatewayError("device_dispatch_stored_state_invalid");
      }
      requireFingerprint(prior, fingerprint);
      return { outcome: "existing", record: cloneRecord(prior) };
    }
    const currentKind = this.#executionKinds.kind(command.executionId);
    if (currentKind === "workspaceList") {
      throw new DeviceGatewayError("device_dispatch_kind_conflict");
    }
    if (currentKind === "tool") {
      throw new DeviceGatewayError("device_dispatch_stored_state_invalid");
    }
    const record: DeviceDispatchAuthorityRecord = {
      executionId: command.executionId,
      fingerprint,
      command,
      resolution: null,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    };
    this.#executionKinds.claim(command.executionId, "tool");
    this.#records.set(command.executionId, cloneRecord(record));
    return { outcome: "created", record: cloneRecord(record) };
  }

  async complete(
    input: DeviceExecutionCommand,
    inputResolution: DeviceGatewayDispatchResolution,
    completedAt: string,
  ): Promise<DeviceDispatchAuthorityRecord> {
    this.#assertOpen();
    const command = parseDeviceExecutionCommand(input);
    const resolution = parseDeviceGatewayDispatchResolution(inputResolution);
    requireTimestamp(completedAt);
    requireResolutionIdentity(command, resolution);
    const prior = this.#records.get(command.executionId);
    if (prior === undefined) {
      throw new DeviceGatewayError("device_dispatch_authority_missing");
    }
    requireFingerprint(prior, deviceDispatchFingerprint(command));
    if (prior.resolution !== null) {
      if (!sameJson(prior.resolution, resolution)) {
        throw new DeviceGatewayError("device_dispatch_terminal_conflict");
      }
      return cloneRecord(prior);
    }
    const completed = {
      ...prior,
      resolution,
      updatedAt: completedAt,
    };
    this.#records.set(command.executionId, cloneRecord(completed));
    return cloneRecord(completed);
  }

  async load(
    executionId: string,
  ): Promise<DeviceDispatchAuthorityRecord | null> {
    this.#assertOpen();
    requireOpaqueId(executionId);
    const record = this.#records.get(executionId);
    return record === undefined ? null : cloneRecord(record);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#records.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("device_dispatch_store_closed");
    }
  }
}

export function parseDeviceDispatchAuthorityRecord(
  input: unknown,
): DeviceDispatchAuthorityRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DeviceGatewayError("device_dispatch_authority_invalid");
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [
    "command",
    "createdAt",
    "executionId",
    "fingerprint",
    "resolution",
    "updatedAt",
  ].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new DeviceGatewayError("device_dispatch_authority_invalid");
  }
  const command = parseDeviceExecutionCommand(value.command);
  const executionId = requireOpaqueId(value.executionId);
  if (
    executionId !== command.executionId ||
    value.fingerprint !== deviceDispatchFingerprint(command)
  ) {
    throw new DeviceGatewayError("device_dispatch_authority_corrupt");
  }
  const resolution =
    value.resolution === null
      ? null
      : parseDeviceGatewayDispatchResolution(value.resolution);
  if (resolution !== null) {
    requireResolutionIdentity(command, resolution);
  }
  requireTimestamp(value.createdAt);
  requireTimestamp(value.updatedAt);
  return {
    executionId,
    fingerprint: value.fingerprint,
    command,
    resolution,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  } as DeviceDispatchAuthorityRecord;
}

function requireFingerprint(
  record: DeviceDispatchAuthorityRecord,
  fingerprint: string,
): void {
  if (record.fingerprint !== fingerprint) {
    throw new DeviceGatewayError("device_dispatch_identity_conflict");
  }
}

function requireResolutionIdentity(
  command: DeviceExecutionCommand,
  resolution: DeviceGatewayDispatchResolution,
): void {
  if (command.executionId !== resolution.executionId) {
    throw new DeviceGatewayError(
      "device_dispatch_resolution_identity_mismatch",
    );
  }
}

function requireTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new DeviceGatewayError("device_dispatch_timestamp_invalid");
  }
}

function requireOpaqueId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
  ) {
    throw new DeviceGatewayError("device_execution_id_invalid");
  }
  return value;
}

function cloneRecord(
  record: DeviceDispatchAuthorityRecord,
): DeviceDispatchAuthorityRecord {
  return structuredClone(record);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
