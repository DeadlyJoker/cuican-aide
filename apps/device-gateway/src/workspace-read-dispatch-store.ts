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
    route: WorkspaceReadRouteFence,
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
    for (const input of config.initialRecords ?? []) {
      const record = parseWorkspaceReadDispatchRecord(input);
      this.#kinds.claim(record.executionId, "workspaceRead");
      this.#records.set(record.executionId, clone(record));
    }
  }

  async ready(): Promise<void> {
    this.#assertOpen();
  }

  async prepare(
    input: DeviceFilesystemReadCommand,
    route: WorkspaceReadRouteFence,
    at: string,
  ) {
    this.#assertOpen();
    const command = parseDeviceFilesystemReadCommand(input);
    timestamp(at);
    requireRoute(command, route);
    if (!same(this.#currentRoute(command.deviceId), route))
      conflict("workspace_read_route_stale");
    const fingerprint = fingerprintFor(command, route);
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
      route: clone(route),
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
      prior.route === null ||
      prior.fingerprint !== fingerprintFor(command, prior.route)
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
    if (prior.route !== null && !same(prior.route, input.route))
      conflict("workspace_read_route_stale");
    if (
      event.sequence === 1 &&
      !same(this.#currentRoute(command.deviceId), input.route)
    )
      conflict("workspace_read_route_stale");
    const now = this.#timestamp();
    if (
      (event.sequence === 2 &&
        prior.acceptedEvent !== null &&
        Date.parse(event.observedAt) <
          Date.parse(prior.acceptedEvent.observedAt)) ||
      Date.parse(now) < Date.parse(prior.updatedAt)
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
    const record = this.#records.get(executionId);
    return record === undefined
      ? null
      : parseWorkspaceReadDispatchRecord(record);
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
  route: WorkspaceReadRouteFence,
): string {
  return fingerprintFor(parseDeviceFilesystemReadCommand(command), route);
}

export function parseWorkspaceReadDispatchRecord(
  input: unknown,
): WorkspaceReadDispatchRecord {
  if (input === null || Array.isArray(input) || typeof input !== "object")
    conflict("workspace_read_record_invalid");
  const value = input as Record<string, unknown>;
  const keys = [
    "acceptedEvent",
    "command",
    "createdAt",
    "executionId",
    "fingerprint",
    "resolution",
    "route",
    "terminalEvent",
    "updatedAt",
  ];
  if (Object.keys(value).sort().join() !== keys.sort().join())
    conflict("workspace_read_record_invalid");
  const command = parseDeviceFilesystemReadCommand(value.command);
  const route = value.route as WorkspaceReadRouteFence;
  requireRoute(command, route);
  const acceptedEvent =
    value.acceptedEvent === null
      ? null
      : readEvent(value.acceptedEvent as DeviceFilesystemReadEvent);
  const terminalEvent =
    value.terminalEvent === null
      ? null
      : readEvent(value.terminalEvent as DeviceFilesystemReadEvent);
  timestamp(String(value.createdAt));
  timestamp(String(value.updatedAt));
  if (
    value.executionId !== command.executionId ||
    value.fingerprint !== fingerprintFor(command, route) ||
    Date.parse(String(value.updatedAt)) < Date.parse(String(value.createdAt))
  )
    conflict("workspace_read_record_invalid");
  if (acceptedEvent !== null)
    requireEventIdentity(command, acceptedEvent, route.connectionEpoch);
  if (terminalEvent !== null) {
    requireEventIdentity(command, terminalEvent, route.connectionEpoch);
    if (
      acceptedEvent === null ||
      terminalEvent.receiptId !== acceptedEvent.receiptId ||
      Date.parse(terminalEvent.observedAt) <
        Date.parse(acceptedEvent.observedAt)
    )
      conflict("workspace_read_record_invalid");
  }
  const expectedResolution =
    terminalEvent === null ? null : resolution(terminalEvent);
  if (!same(value.resolution, expectedResolution))
    conflict("workspace_read_record_invalid");
  return clone({
    executionId: command.executionId,
    fingerprint: value.fingerprint as string,
    command,
    route,
    acceptedEvent,
    terminalEvent,
    resolution: expectedResolution,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  });
}

function fingerprintFor(
  command: DeviceFilesystemReadCommand,
  route: WorkspaceReadRouteFence,
): string {
  return digestUtf8(JSON.stringify({ commandDigest: digest(command), route }));
}
function requireRoute(
  command: DeviceFilesystemReadCommand,
  route: WorkspaceReadRouteFence,
): void {
  if (
    route === null ||
    typeof route !== "object" ||
    route.deviceId !== command.deviceId ||
    route.capability !== "workspace.read_file.v0" ||
    !Number.isFinite(Date.parse(route.leaseExpiresAt))
  )
    conflict("workspace_read_route_invalid");
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
