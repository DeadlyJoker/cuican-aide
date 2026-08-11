import {
  DEVICE_PROTOCOL_VERSION,
  parseDeviceWorkspaceListAck,
  parseDeviceWorkspaceListCommand,
  parseDeviceWorkspaceListEvent,
  parseDeviceWorkspaceListEventForCommand,
  type DeviceExecutionCancel,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceWorkspaceListEvent,
} from "@crewon/contracts";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { CommitWorkspaceDispatchEventResult } from "./workspace-dispatch-store.ts";

export const WORKSPACE_LIST_CAPABILITY = "workspace.list_top_level.v0" as const;

export type WorkspaceSessionExecutionMode =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{
      kind: "durableReplay";
      acceptedConnectionEpoch: number;
    }>;

export type WorkspaceSessionEventCommitter = (
  event: DeviceWorkspaceListEvent,
) => Promise<CommitWorkspaceDispatchEventResult>;

type PendingWorkspaceExecution = {
  command: DeviceWorkspaceListCommand;
  connectionEpoch: number;
  commit: WorkspaceSessionEventCommitter;
  receiptId: string | null;
  sendState: "notStarted" | "possiblySent" | "sent";
  cancelTimeout: () => void;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (resolution: DeviceWorkspaceListDispatchResolution) => void;
  reject: (error: Error) => void;
};

/** Owns only Workspace-list frames multiplexed over one Device socket. */
export class DeviceGatewayWorkspaceSession {
  readonly #deviceId: string;
  readonly #lastAcknowledged: ReadonlyMap<string, number>;
  readonly #now: () => Date;
  readonly #send: (value: object) => Promise<void>;
  readonly #schedule: (delayMs: number, callback: () => void) => () => void;
  readonly #pending = new Map<string, PendingWorkspaceExecution>();
  #orphanCommitter: WorkspaceSessionEventCommitter | null = null;
  #closed = false;

  constructor(config: {
    deviceId: string;
    lastAcknowledged: readonly Readonly<{
      executionId: string;
      sequence: number;
    }>[];
    now: () => Date;
    send: (value: object) => Promise<void>;
    schedule?: (delayMs: number, callback: () => void) => () => void;
    orphanCommitter?: WorkspaceSessionEventCommitter;
  }) {
    this.#deviceId = config.deviceId;
    this.#lastAcknowledged = new Map(
      config.lastAcknowledged.map((item) => [item.executionId, item.sequence]),
    );
    this.#now = config.now;
    this.#send = config.send;
    this.#schedule = config.schedule ?? systemSchedule;
    this.#orphanCommitter = config.orphanCommitter ?? null;
  }

  execute(
    rawCommand: DeviceWorkspaceListCommand,
    connectionEpoch: number,
    mode: WorkspaceSessionExecutionMode,
    signal: AbortSignal,
    commit: WorkspaceSessionEventCommitter,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    this.#assertOpen();
    const command = parseDeviceWorkspaceListCommand(rawCommand);
    if (command.deviceId !== this.#deviceId) {
      throw new DeviceGatewayError("device_command_identity_mismatch");
    }
    if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1) {
      throw new DeviceGatewayError("device_connection_route_stale");
    }
    if (signal.aborted) {
      throw new DeviceGatewayError("workspace_dispatch_not_sent");
    }
    if (this.#pending.has(command.executionId)) {
      throw new DeviceGatewayError("device_execution_already_pending");
    }
    return new Promise<DeviceWorkspaceListDispatchResolution>(
      (resolve, reject) => {
        const onAbort = () => {
          try {
            this.requestCancel(command.executionId, "caller_aborted");
          } catch {
            // The caller still receives the durable certainty below.
          }
          this.#finishUnknown(command.executionId);
        };
        const remainingMs =
          mode.kind === "fresh"
            ? Math.min(
                Date.parse(command.expiresAt) - this.#now().getTime(),
                command.limits.timeoutMs,
              )
            : command.limits.timeoutMs;
        if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
          reject(new DeviceGatewayError("device_authorization_expired"));
          return;
        }
        const cancelTimeout = this.#schedule(remainingMs, () => {
          try {
            this.requestCancel(command.executionId, "execution_timeout");
          } catch {
            // The bounded request still resolves with its durable certainty.
          }
          this.#finishUnknown(command.executionId);
        });
        const eventConnectionEpoch =
          mode.kind === "fresh"
            ? connectionEpoch
            : mode.acceptedConnectionEpoch;
        if (
          !Number.isSafeInteger(eventConnectionEpoch) ||
          eventConnectionEpoch < 1
        ) {
          cancelTimeout();
          reject(new DeviceGatewayError("device_connection_route_stale"));
          return;
        }
        const pending: PendingWorkspaceExecution = {
          command,
          connectionEpoch: eventConnectionEpoch,
          commit,
          receiptId: null,
          sendState: "notStarted",
          cancelTimeout,
          signal,
          onAbort,
          resolve,
          reject,
        };
        this.#pending.set(command.executionId, pending);
        signal.addEventListener("abort", onAbort, { once: true });
        let sending: Promise<void>;
        try {
          sending = this.#send(command);
          pending.sendState = "possiblySent";
        } catch (error) {
          this.#pending.delete(command.executionId);
          cleanup(pending);
          reject(
            new DeviceGatewayError("workspace_dispatch_not_sent", {
              cause: error,
            }),
          );
          return;
        }
        void sending.then(
          () => {
            if (this.#pending.get(command.executionId) === pending) {
              pending.sendState = "sent";
            }
          },
          (error: unknown) => {
            if (this.#pending.get(command.executionId) !== pending) return;
            this.#pending.delete(command.executionId);
            cleanup(pending);
            reject(
              new DeviceGatewayError("workspace_dispatch_possibly_sent", {
                cause: error,
              }),
            );
          },
        );
      },
    );
  }

  acknowledgedSequence(executionId: string): number | null {
    return this.#lastAcknowledged.get(executionId) ?? null;
  }

  requestCancel(executionId: string, reasonCode: string): void {
    this.#assertOpen();
    if (!/^[a-z0-9_.:-]{1,128}$/u.test(reasonCode)) {
      throw new DeviceGatewayError("device_cancel_reason_invalid");
    }
    const pending = this.#pending.get(executionId);
    if (pending === undefined) {
      throw new DeviceGatewayError("device_execution_not_pending");
    }
    const cancel: DeviceExecutionCancel = {
      schemaVersion: "crewon.device-cancel.v0",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      deviceId: this.#deviceId,
      executionId,
      leaseId: pending.command.leaseId,
      leaseEpoch: pending.command.leaseEpoch,
      reasonCode,
      requestedAt: this.#timestamp(),
    };
    void this.#send(cancel).catch(() => this.#finishUnknown(executionId));
  }

  setOrphanCommitter(committer: WorkspaceSessionEventCommitter | null): void {
    this.#orphanCommitter = committer;
  }

  async handleFrame(input: unknown): Promise<boolean> {
    if (!isWorkspaceEventEnvelope(input)) return false;
    const event = parseDeviceWorkspaceListEvent(input);
    if (event.deviceId !== this.#deviceId) {
      throw new DeviceGatewayError("device_event_identity_mismatch");
    }
    const pending = this.#pending.get(event.executionId);
    if (pending === undefined) {
      if (this.#orphanCommitter === null) {
        throw new DeviceGatewayError("device_execution_unknown");
      }
      const committed = await this.#orphanCommitter(event);
      await this.#send(
        parseDeviceWorkspaceListAck({
          ...committed.acknowledgement,
          acknowledgedAt: this.#timestamp(),
        }),
      );
      return true;
    }
    const validated = parseDeviceWorkspaceListEventForCommand(
      event,
      pending.command,
      pending.connectionEpoch,
    );
    pending.sendState = "sent";
    const committed = await pending.commit(validated);
    if (validated.type === "workspace_list.accepted") {
      pending.receiptId = validated.receiptId;
    }
    const acknowledgement = parseDeviceWorkspaceListAck({
      ...committed.acknowledgement,
      acknowledgedAt: this.#timestamp(),
    });
    if (validated.type !== "workspace_list.accepted") {
      if (committed.record.resolution === null) {
        throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
      }
      this.#pending.delete(validated.executionId);
      cleanup(pending);
      pending.resolve(structuredClone(committed.record.resolution));
    }
    await this.#send(acknowledgement);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const executionId of [...this.#pending.keys()]) {
      this.#finishUnknown(executionId);
    }
  }

  #finishUnknown(executionId: string): void {
    const pending = this.#pending.get(executionId);
    if (pending === undefined) return;
    this.#pending.delete(executionId);
    cleanup(pending);
    if (pending.sendState === "notStarted") {
      pending.reject(new DeviceGatewayError("workspace_dispatch_not_sent"));
      return;
    }
    pending.resolve({
      status: "unknownOutcome",
      executionId,
      receiptId: pending.receiptId,
      terminal: null,
    });
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new DeviceGatewayError("workspace_dispatch_clock_invalid");
    }
    return value.toISOString();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("device_session_closed");
    }
  }
}

function cleanup(pending: PendingWorkspaceExecution): void {
  pending.cancelTimeout();
  pending.signal.removeEventListener("abort", pending.onAbort);
}

function systemSchedule(delayMs: number, callback: () => void): () => void {
  const timeout = setTimeout(callback, Math.min(delayMs, 2_147_483_647));
  timeout.unref();
  return () => clearTimeout(timeout);
}

function isWorkspaceEventEnvelope(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      "crewon.device-workspace-list-event.v0"
  );
}
