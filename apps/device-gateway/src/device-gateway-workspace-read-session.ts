import {
  DEVICE_FILESYSTEM_READ_CAPABILITY,
  parseDeviceFilesystemReadAck,
  parseDeviceFilesystemReadCommand,
  parseDeviceFilesystemReadEvent,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadEvent,
} from "@crewon/contracts";
import { createHash } from "node:crypto";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import type {
  WorkspaceReadCommitResult,
  WorkspaceReadResolution,
} from "./workspace-read-dispatch-store.ts";

export type WorkspaceReadEventCommitter = (
  event: DeviceFilesystemReadEvent,
) => Promise<WorkspaceReadCommitResult>;

type Pending = {
  command: DeviceFilesystemReadCommand;
  epoch: number;
  commit: WorkspaceReadEventCommitter;
  receiptId: string | null;
  timer: () => void;
  signal: AbortSignal;
  onAbort: () => void;
  sendState: "notStarted" | "possiblySent" | "sent";
  resolve: (value: WorkspaceReadResolution) => void;
  reject: (error: Error) => void;
};

/** Owns only workspace-read frames multiplexed over one Device socket. */
export class DeviceGatewayWorkspaceReadSession {
  readonly #deviceId: string;
  readonly #now: () => Date;
  readonly #send: (value: object) => Promise<void>;
  readonly #schedule: (ms: number, callback: () => void) => () => void;
  readonly #pending = new Map<string, Pending>();
  #orphan: WorkspaceReadEventCommitter | null = null;
  #closed = false;

  constructor(config: {
    deviceId: string;
    now: () => Date;
    send: (value: object) => Promise<void>;
    schedule?: (ms: number, callback: () => void) => () => void;
  }) {
    this.#deviceId = config.deviceId;
    this.#now = config.now;
    this.#send = config.send;
    this.#schedule = config.schedule ?? systemSchedule;
  }

  execute(
    commandInput: DeviceFilesystemReadCommand,
    epoch: number,
    replay: boolean,
    signal: AbortSignal,
    commit: WorkspaceReadEventCommitter,
  ): Promise<WorkspaceReadResolution> {
    if (this.#closed) throw new DeviceGatewayError("device_session_closed");
    const command = parseDeviceFilesystemReadCommand(commandInput);
    if (command.deviceId !== this.#deviceId)
      throw new DeviceGatewayError("device_command_identity_mismatch");
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new DeviceGatewayError("device_connection_route_stale");
    if (signal.aborted) throw new DeviceGatewayError("workspace_read_not_sent");
    if (this.#pending.has(command.executionId))
      throw new DeviceGatewayError("device_execution_already_pending");
    const remaining = replay
      ? command.limits.timeoutMs
      : Math.min(
          command.limits.timeoutMs,
          Date.parse(command.expiresAt) - this.#now().getTime(),
        );
    if (remaining <= 0)
      throw new DeviceGatewayError("device_authorization_expired");
    return new Promise((resolve, reject) => {
      const timer = this.#schedule(remaining, () =>
        this.#unknown(command.executionId),
      );
      const onAbort = () => this.#unknown(command.executionId);
      const pending: Pending = {
        command,
        epoch,
        commit,
        receiptId: null,
        timer,
        signal,
        onAbort,
        sendState: "notStarted",
        resolve,
        reject,
      };
      this.#pending.set(command.executionId, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      let sending: Promise<void>;
      try {
        sending = this.#send(command);
        pending.sendState = "possiblySent";
      } catch (cause) {
        this.#pending.delete(command.executionId);
        cleanup(pending);
        reject(new DeviceGatewayError("workspace_read_not_sent", { cause }));
        return;
      }
      void sending
        .then(() => {
          if (this.#pending.get(command.executionId) === pending)
            pending.sendState = "sent";
        })
        .catch((cause) => {
          if (this.#pending.delete(command.executionId)) {
            cleanup(pending);
            reject(
              new DeviceGatewayError("workspace_read_possibly_sent", { cause }),
            );
          }
        });
    });
  }

  setOrphanCommitter(value: WorkspaceReadEventCommitter | null): void {
    this.#orphan = value;
  }

  async handleFrame(input: unknown): Promise<boolean> {
    if (!isReadEvent(input)) return false;
    const event = parseDeviceFilesystemReadEvent(input, digestUtf8);
    if (event.deviceId !== this.#deviceId)
      throw new DeviceGatewayError("device_event_identity_mismatch");
    const pending = this.#pending.get(event.executionId);
    const committed =
      pending === undefined
        ? await this.#commitOrphan(event)
        : await pending.commit(event);
    if (pending !== undefined) {
      if (event.sequence === 1) pending.receiptId = event.receiptId;
      else {
        this.#pending.delete(event.executionId);
        cleanup(pending);
        if (committed.record.resolution === null)
          throw new DeviceGatewayError("workspace_read_stored_state_invalid");
        pending.resolve(structuredClone(committed.record.resolution));
      }
    }
    await this.#send(
      parseDeviceFilesystemReadAck({
        ...committed.acknowledgement,
        acknowledgedAt: this.#now().toISOString(),
      }),
    );
    return true;
  }

  close(): void {
    this.#closed = true;
    for (const id of this.#pending.keys()) this.#unknown(id);
  }

  async #commitOrphan(event: DeviceFilesystemReadEvent) {
    if (this.#orphan === null)
      throw new DeviceGatewayError("device_execution_unknown");
    return this.#orphan(event);
  }
  #unknown(executionId: string) {
    const pending = this.#pending.get(executionId);
    if (pending === undefined) return;
    this.#pending.delete(executionId);
    cleanup(pending);
    if (pending.sendState === "notStarted") {
      pending.reject(new DeviceGatewayError("workspace_read_not_sent"));
      return;
    }
    pending.resolve({
      status: "unknownOutcome",
      executionId,
      receiptId: pending.receiptId,
      terminal: null,
    });
  }
}

function isReadEvent(value: unknown): value is DeviceFilesystemReadEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      "crewon.device-filesystem-read-event.v0"
  );
}
function digestUtf8(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function systemSchedule(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, Math.min(ms, 2_147_483_647));
  timer.unref();
  return () => clearTimeout(timer);
}
function cleanup(pending: Pending): void {
  pending.timer();
  pending.signal.removeEventListener("abort", pending.onAbort);
}
