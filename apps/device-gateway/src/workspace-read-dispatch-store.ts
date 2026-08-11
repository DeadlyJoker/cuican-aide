import { createHash } from "node:crypto";

import {
  canonicalDeviceFilesystemReadCommandDigest,
  parseDeviceFilesystemReadCommand,
  parseDeviceFilesystemReadEvent,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadEvent,
  type DeviceFilesystemReadAck,
} from "@crewon/contracts";

import { InMemoryDeviceExecutionKindAuthority } from "./device-execution-kind-authority.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

export type WorkspaceReadResolution = Readonly<{
  status: "completed" | "failed" | "canceled" | "unknownOutcome";
  executionId: string;
  receiptId: string | null;
  terminal: DeviceFilesystemReadEvent | null;
}>;

export type WorkspaceReadDispatchRecord = Readonly<{
  executionId: string;
  fingerprint: string;
  command: DeviceFilesystemReadCommand;
  route: WorkspaceReadRouteFence | null;
  acceptedEvent: DeviceFilesystemReadEvent | null;
  terminalEvent: DeviceFilesystemReadEvent | null;
  resolution: WorkspaceReadResolution | null;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkspaceReadCommitResult = Readonly<{
  outcome: "committed" | "replayed";
  record: WorkspaceReadDispatchRecord;
  acknowledgement: Omit<DeviceFilesystemReadAck, "acknowledgedAt">;
}>;

export type WorkspaceReadRouteFence = Readonly<{
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  connectionEpoch: number;
  deviceBindingId: string;
  runtimeBindingId: string;
  capability: "workspace.read_file.v0";
  leaseExpiresAt: string;
}>;

export interface WorkspaceReadDispatchStorePort {
  ready(): Promise<void>;
  prepare(
    command: DeviceFilesystemReadCommand,
    at: string,
  ): Promise<
    Readonly<{
      outcome: "created" | "existing";
      record: WorkspaceReadDispatchRecord;
    }>
  >;
  commit(
    input: Readonly<{
      command: DeviceFilesystemReadCommand;
      route: WorkspaceReadRouteFence;
      event: DeviceFilesystemReadEvent;
    }>,
  ): Promise<WorkspaceReadCommitResult>;
  load(executionId: string): Promise<WorkspaceReadDispatchRecord | null>;
  close(): Promise<void>;
}

export class InMemoryWorkspaceReadDispatchStore
  implements WorkspaceReadDispatchStorePort
{
  readonly #kinds: InMemoryDeviceExecutionKindAuthority;
  readonly #now: () => Date;
  readonly #records = new Map<string, WorkspaceReadDispatchRecord>();
  #closed = false;

  readonly #currentRoute: (deviceId: string) => WorkspaceReadRouteFence | null;
  constructor(config: {
    now: () => Date;
    currentRoute: (deviceId: string) => WorkspaceReadRouteFence | null;
    executionKinds?: InMemoryDeviceExecutionKindAuthority;
    initialRecords?: readonly WorkspaceReadDispatchRecord[];
  }) {
    this.#now = config.now;
    this.#kinds =
      config.executionKinds ?? new InMemoryDeviceExecutionKindAuthority();
    this.#currentRoute = config.currentRoute;
    for (const record of config.initialRecords ?? []) {
      this.#kinds.claim(record.executionId, "workspaceRead");
      this.#records.set(record.executionId, clone(record));
    }
  }

  async ready(): Promise<void> {
    this.#assertOpen();
  }

  async prepare(input: DeviceFilesystemReadCommand, at: string) {
    this.#assertOpen();
    const command = parseDeviceFilesystemReadCommand(input);
    timestamp(at);
    const fingerprint = digest(command);
    const prior = this.#records.get(command.executionId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint)
        conflict("workspace_read_identity_conflict");
      return { outcome: "existing" as const, record: clone(prior) };
    }
    if (this.#kinds.kind(command.executionId) !== null)
      conflict("device_dispatch_kind_conflict");
    const record: WorkspaceReadDispatchRecord = {
      executionId: command.executionId,
      fingerprint,
      command,
      route: null,
      acceptedEvent: null,
      terminalEvent: null,
      resolution: null,
      createdAt: at,
      updatedAt: at,
    };
    this.#kinds.claim(command.executionId, "workspaceRead");
    this.#records.set(command.executionId, clone(record));
    return { outcome: "created" as const, record: clone(record) };
  }

  async commit(
    input: Readonly<{
      command: DeviceFilesystemReadCommand;
      route: WorkspaceReadRouteFence;
      event: DeviceFilesystemReadEvent;
    }>,
  ): Promise<WorkspaceReadCommitResult> {
    this.#assertOpen();
    const command = parseDeviceFilesystemReadCommand(input.command);
    const event = readEvent(input.event);
    const prior = this.#records.get(command.executionId);
    if (
      this.#kinds.kind(command.executionId) !== "workspaceRead" ||
      prior === undefined ||
      prior.fingerprint !== digest(command)
    )
      conflict("workspace_read_authority_missing");
    requireEventIdentity(command, event, input.route.connectionEpoch);
    const current =
      event.sequence === 1 ? prior.acceptedEvent : prior.terminalEvent;
    if (current !== null) {
      if (JSON.stringify(current) !== JSON.stringify(event))
        conflict("workspace_read_event_conflict");
      return result("replayed", prior, event);
    }
    if (event.sequence === 2 && prior.acceptedEvent === null)
      conflict("workspace_read_accepted_missing");
    if (
      event.sequence === 2 &&
      prior.acceptedEvent?.receiptId !== event.receiptId
    )
      conflict("workspace_read_event_conflict");
    if (
      prior.route !== null &&
      JSON.stringify(prior.route) !== JSON.stringify(input.route)
    )
      conflict("workspace_read_route_stale");
    if (
      event.sequence === 1 &&
      JSON.stringify(this.#currentRoute(command.deviceId)) !==
        JSON.stringify(input.route)
    )
      conflict("workspace_read_route_stale");
    const now = this.#timestamp();
    if (
      Date.parse(event.observedAt) < Date.parse(prior.updatedAt) ||
      Date.parse(now) < Date.parse(event.observedAt)
    )
      conflict("workspace_read_event_time_invalid");
    const terminal = event.sequence === 2 ? event : null;
    const committed: WorkspaceReadDispatchRecord = {
      ...prior,
      route: prior.route ?? structuredClone(input.route),
      acceptedEvent: event.sequence === 1 ? event : prior.acceptedEvent,
      terminalEvent: terminal,
      resolution: terminal === null ? null : resolution(terminal),
      updatedAt: now,
    };
    this.#records.set(command.executionId, clone(committed));
    return result("committed", committed, event);
  }

  async load(executionId: string) {
    this.#assertOpen();
    if (this.#kinds.kind(executionId) !== "workspaceRead") return null;
    return clone(this.#records.get(executionId) ?? null);
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#records.clear();
  }
  #assertOpen() {
    if (this.#closed) conflict("workspace_read_store_closed");
  }
  #timestamp() {
    const value = this.#now();
    if (!Number.isFinite(value.getTime()))
      conflict("workspace_read_clock_invalid");
    return value.toISOString();
  }
}

export function workspaceReadFingerprint(
  command: DeviceFilesystemReadCommand,
): string {
  return digest(parseDeviceFilesystemReadCommand(command));
}

function readEvent(
  input: DeviceFilesystemReadEvent,
): DeviceFilesystemReadEvent {
  return parseDeviceFilesystemReadEvent(input, digestUtf8);
}
function digest(command: DeviceFilesystemReadCommand): string {
  return canonicalDeviceFilesystemReadCommandDigest(command, digestUtf8);
}
function digestUtf8(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function requireEventIdentity(
  command: DeviceFilesystemReadCommand,
  event: DeviceFilesystemReadEvent,
  epoch: number,
) {
  if (
    event.deviceId !== command.deviceId ||
    event.executionId !== command.executionId ||
    event.workspaceBindingId !== command.workspaceBindingId ||
    event.incarnationId !== command.arguments.workspaceIncarnationId ||
    event.connectionEpoch !== epoch ||
    event.commandDigest !== digest(command)
  )
    conflict("workspace_read_event_identity_mismatch");
}
function resolution(event: DeviceFilesystemReadEvent): WorkspaceReadResolution {
  const status =
    event.type === "workspace_read.completed"
      ? "completed"
      : event.type === "workspace_read.failed"
        ? "failed"
        : event.type === "workspace_read.canceled"
          ? "canceled"
          : "unknownOutcome";
  return {
    status,
    executionId: event.executionId,
    receiptId: event.receiptId,
    terminal: event,
  };
}
function result(
  outcome: "committed" | "replayed",
  record: WorkspaceReadDispatchRecord,
  event: DeviceFilesystemReadEvent,
): WorkspaceReadCommitResult {
  return {
    outcome,
    record: clone(record),
    acknowledgement: {
      schemaVersion: "crewon.device-filesystem-read-ack.v0",
      protocolVersion: 1,
      commandKind: "workspaceRead",
      deviceId: event.deviceId,
      executionId: event.executionId,
      receiptId: event.receiptId,
      connectionEpoch: event.connectionEpoch,
      workspaceBindingId: event.workspaceBindingId,
      incarnationId: event.incarnationId,
      commandDigest: event.commandDigest,
      throughSequence: event.sequence,
    },
  };
}
function timestamp(value: string) {
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value)))
    conflict("workspace_read_timestamp_invalid");
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function conflict(code: string): never {
  throw new DeviceGatewayError(code);
}
