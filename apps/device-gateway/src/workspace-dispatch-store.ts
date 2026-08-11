import {
  parseDeviceWorkspaceListCommand,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListEvent,
  type DeviceWorkspaceListPeerRoute,
} from "@crewon/contracts";

import { InMemoryDeviceExecutionKindAuthority } from "./device-execution-kind-authority.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  parseWorkspaceDispatchAuthorityRecord,
  parseWorkspaceDispatchRoute,
  requireWorkspaceDispatchNotBefore,
  requireWorkspaceDispatchRouteCurrent,
  requireWorkspaceDispatchTimestamp,
  sameWorkspaceDispatchJson,
  sameWorkspaceDispatchRouteFence,
  validateAcceptWorkspaceDispatchEventInput,
  validateSettleWorkspaceDispatchEventInput,
  workspaceDispatchFingerprint,
  type AcceptWorkspaceDispatchEventInput,
  type SettleWorkspaceDispatchEventInput,
  type WorkspaceDispatchAuthorityRecord,
} from "./workspace-dispatch-authority.ts";

export type {
  AcceptWorkspaceDispatchEventInput,
  SettleWorkspaceDispatchEventInput,
  WorkspaceDispatchAuthorityRecord,
} from "./workspace-dispatch-authority.ts";
export {
  parseWorkspaceDispatchAuthorityRecord,
  workspaceDispatchFingerprint,
} from "./workspace-dispatch-authority.ts";

export type WorkspaceDispatchAcknowledgementAuthority = Readonly<{
  schemaVersion: "crewon.device-workspace-list-ack.v0";
  protocolVersion: 1;
  commandKind: "workspaceList";
  deviceId: string;
  executionId: string;
  receiptId: string;
  connectionEpoch: number;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  runtimeBindingId: string;
  actionDigest: string;
  commandDigest: string;
  throughSequence: number;
}>;

export type PrepareWorkspaceDispatchResult = Readonly<{
  outcome: "created" | "existing";
  record: WorkspaceDispatchAuthorityRecord;
}>;

export type CommitWorkspaceDispatchEventResult = Readonly<{
  outcome: "committed" | "replayed";
  record: WorkspaceDispatchAuthorityRecord;
  acknowledgement: WorkspaceDispatchAcknowledgementAuthority;
}>;

/** Owns Workspace-list command, event and terminal receipt authority. */
export interface WorkspaceDispatchStorePort {
  ready(): Promise<void>;
  prepare(
    command: DeviceWorkspaceListCommand,
    preparedAt: string,
  ): Promise<PrepareWorkspaceDispatchResult>;
  acceptEvent(
    input: AcceptWorkspaceDispatchEventInput,
  ): Promise<CommitWorkspaceDispatchEventResult>;
  settleEvent(
    input: SettleWorkspaceDispatchEventInput,
  ): Promise<CommitWorkspaceDispatchEventResult>;
  load(executionId: string): Promise<WorkspaceDispatchAuthorityRecord | null>;
  close(): Promise<void>;
}

/** Supplies the server-owned current Device route inside the Store boundary. */
export interface WorkspaceDispatchRouteAuthorityPort {
  currentRoute(deviceId: string): DeviceWorkspaceListPeerRoute | null;
}

export type InMemoryWorkspaceDispatchStoreConfig = Readonly<{
  routeAuthority: WorkspaceDispatchRouteAuthorityPort;
  now: () => Date;
  executionKinds?: InMemoryDeviceExecutionKindAuthority;
  initialRecords?: readonly WorkspaceDispatchAuthorityRecord[];
}>;

export class InMemoryWorkspaceDispatchStore
  implements WorkspaceDispatchStorePort
{
  readonly #executionKinds: InMemoryDeviceExecutionKindAuthority;
  readonly #routeAuthority: WorkspaceDispatchRouteAuthorityPort;
  readonly #now: () => Date;
  readonly #records = new Map<string, WorkspaceDispatchAuthorityRecord>();
  #closed = false;

  constructor(config: InMemoryWorkspaceDispatchStoreConfig) {
    this.#executionKinds =
      config.executionKinds ?? new InMemoryDeviceExecutionKindAuthority();
    this.#routeAuthority = config.routeAuthority;
    this.#now = config.now;
    const records = (config.initialRecords ?? []).map(
      parseWorkspaceDispatchAuthorityRecord,
    );
    const seen = new Set<string>();
    for (const record of records) {
      if (
        seen.has(record.executionId) ||
        this.#executionKinds.kind(record.executionId) === "tool"
      ) {
        throw new DeviceGatewayError("device_dispatch_kind_conflict");
      }
      seen.add(record.executionId);
    }
    for (const record of records) {
      this.#executionKinds.claim(record.executionId, "workspaceList");
      this.#records.set(record.executionId, cloneRecord(record));
    }
  }

  async ready(): Promise<void> {
    this.#assertOpen();
  }

  async prepare(
    input: DeviceWorkspaceListCommand,
    preparedAt: string,
  ): Promise<PrepareWorkspaceDispatchResult> {
    this.#assertOpen();
    const command = parseDeviceWorkspaceListCommand(input);
    requireWorkspaceDispatchTimestamp(preparedAt);
    const fingerprint = workspaceDispatchFingerprint(command);
    const prior = this.#records.get(command.executionId);
    if (prior !== undefined) {
      if (this.#executionKinds.kind(command.executionId) !== "workspaceList") {
        throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
      }
      requireFingerprint(prior, fingerprint);
      return { outcome: "existing", record: validatedClone(prior) };
    }
    const currentKind = this.#executionKinds.kind(command.executionId);
    if (currentKind === "tool") {
      throw new DeviceGatewayError("device_dispatch_kind_conflict");
    }
    if (currentKind === "workspaceList") {
      throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
    }
    const record = parseWorkspaceDispatchAuthorityRecord({
      commandKind: "workspaceList",
      executionId: command.executionId,
      fingerprint,
      command,
      route: null,
      acceptedEvent: null,
      terminalEvent: null,
      resolution: null,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    });
    this.#executionKinds.claim(command.executionId, "workspaceList");
    this.#records.set(command.executionId, cloneRecord(record));
    return { outcome: "created", record: cloneRecord(record) };
  }

  async acceptEvent(
    rawInput: AcceptWorkspaceDispatchEventInput,
  ): Promise<CommitWorkspaceDispatchEventResult> {
    this.#assertOpen();
    const input = validateAcceptWorkspaceDispatchEventInput(rawInput);
    const prior = this.#requiredRecord(input.command);
    if (prior.acceptedEvent !== null) {
      if (
        prior.route === null ||
        !sameWorkspaceDispatchRouteFence(prior.route, input.route) ||
        !sameWorkspaceDispatchJson(prior.acceptedEvent, input.event)
      ) {
        throw new DeviceGatewayError("workspace_dispatch_event_conflict");
      }
      return workspaceDispatchCommitResult(
        "replayed",
        prior,
        prior.acceptedEvent,
      );
    }
    const currentRoute = this.#routeAuthority.currentRoute(
      input.command.deviceId,
    );
    if (currentRoute === null) {
      throw new DeviceGatewayError("workspace_dispatch_route_unavailable");
    }
    const authoritativeRoute = parseWorkspaceDispatchRoute(currentRoute);
    if (!sameWorkspaceDispatchRouteFence(authoritativeRoute, input.route)) {
      throw new DeviceGatewayError("workspace_dispatch_route_stale");
    }
    const committedAt = this.#nowTimestamp();
    requireWorkspaceDispatchRouteCurrent(committedAt, authoritativeRoute);
    requireWorkspaceDispatchNotBefore(committedAt, prior.updatedAt);
    const committed = parseWorkspaceDispatchAuthorityRecord({
      ...prior,
      route: authoritativeRoute,
      acceptedEvent: input.event,
      updatedAt: committedAt,
    });
    this.#records.set(committed.executionId, cloneRecord(committed));
    return workspaceDispatchCommitResult("committed", committed, input.event);
  }

  async settleEvent(
    rawInput: SettleWorkspaceDispatchEventInput,
  ): Promise<CommitWorkspaceDispatchEventResult> {
    this.#assertOpen();
    const input = validateSettleWorkspaceDispatchEventInput(rawInput);
    const prior = this.#requiredRecord(input.command);
    if (prior.acceptedEvent === null || prior.route === null) {
      throw new DeviceGatewayError("workspace_dispatch_accepted_missing");
    }
    if (
      !sameWorkspaceDispatchRouteFence(prior.route, input.route) ||
      prior.acceptedEvent.receiptId !== input.event.receiptId
    ) {
      throw new DeviceGatewayError("workspace_dispatch_event_conflict");
    }
    if (prior.terminalEvent !== null || prior.resolution !== null) {
      if (
        prior.terminalEvent === null ||
        prior.resolution === null ||
        !sameWorkspaceDispatchJson(prior.terminalEvent, input.event) ||
        !sameWorkspaceDispatchJson(prior.resolution, input.resolution)
      ) {
        throw new DeviceGatewayError("workspace_dispatch_terminal_conflict");
      }
      return workspaceDispatchCommitResult(
        "replayed",
        prior,
        prior.terminalEvent,
      );
    }
    const committedAt = this.#nowTimestamp();
    requireWorkspaceDispatchNotBefore(committedAt, prior.updatedAt);
    const committed = parseWorkspaceDispatchAuthorityRecord({
      ...prior,
      terminalEvent: input.event,
      resolution: input.resolution,
      updatedAt: committedAt,
    });
    this.#records.set(committed.executionId, cloneRecord(committed));
    return workspaceDispatchCommitResult("committed", committed, input.event);
  }

  async load(
    executionId: string,
  ): Promise<WorkspaceDispatchAuthorityRecord | null> {
    this.#assertOpen();
    const kind = this.#executionKinds.kind(executionId);
    if (kind === "tool") return null;
    const record = this.#records.get(executionId);
    return record === undefined ? null : validatedClone(record);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#records.clear();
  }

  #requiredRecord(
    command: DeviceWorkspaceListCommand,
  ): WorkspaceDispatchAuthorityRecord {
    if (this.#executionKinds.kind(command.executionId) === "tool") {
      throw new DeviceGatewayError("device_dispatch_kind_conflict");
    }
    const record = this.#records.get(command.executionId);
    if (record === undefined) {
      throw new DeviceGatewayError("workspace_dispatch_authority_missing");
    }
    this.#executionKinds.claim(command.executionId, "workspaceList");
    const validated = parseWorkspaceDispatchAuthorityRecord(record);
    requireFingerprint(validated, workspaceDispatchFingerprint(command));
    return validated;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("workspace_dispatch_store_closed");
    }
  }

  #nowTimestamp(): string {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new DeviceGatewayError("workspace_dispatch_clock_invalid");
    }
    return now.toISOString();
  }
}

export function workspaceDispatchCommitResult(
  outcome: CommitWorkspaceDispatchEventResult["outcome"],
  record: WorkspaceDispatchAuthorityRecord,
  event: DeviceWorkspaceListEvent,
): CommitWorkspaceDispatchEventResult {
  return {
    outcome,
    record: validatedClone(record),
    acknowledgement: {
      schemaVersion: "crewon.device-workspace-list-ack.v0",
      protocolVersion: 1,
      commandKind: "workspaceList",
      deviceId: event.deviceId,
      executionId: event.executionId,
      receiptId: event.receiptId,
      connectionEpoch: event.connectionEpoch,
      workspaceBindingId: event.workspaceBindingId,
      incarnationId: event.incarnationId,
      deviceBindingId: event.deviceBindingId,
      runtimeBindingId: event.runtimeBindingId,
      actionDigest: event.actionDigest,
      commandDigest: event.commandDigest,
      throughSequence: event.sequence,
    },
  };
}

function requireFingerprint(
  record: WorkspaceDispatchAuthorityRecord,
  fingerprint: string,
): void {
  if (record.fingerprint !== fingerprint) {
    throw new DeviceGatewayError("workspace_dispatch_identity_conflict");
  }
}

function validatedClone(
  record: WorkspaceDispatchAuthorityRecord,
): WorkspaceDispatchAuthorityRecord {
  return parseWorkspaceDispatchAuthorityRecord(cloneRecord(record));
}

function cloneRecord(
  record: WorkspaceDispatchAuthorityRecord,
): WorkspaceDispatchAuthorityRecord {
  return structuredClone(record);
}
