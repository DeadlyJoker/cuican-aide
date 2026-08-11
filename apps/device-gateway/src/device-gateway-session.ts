import { createHash } from "node:crypto";

import {
  DEVICE_PROTOCOL_VERSION,
  parseDeviceGatewayWelcome,
  parseDeviceExecutionCommand,
  parseDeviceExecutionEvent,
  parseDeviceHello,
  type DeviceExecutionAck,
  type DeviceExecutionCancel,
  type DeviceExecutionCommand,
  type DeviceExecutionEvent,
  type DeviceGatewayDispatchResolution,
  type DeviceGatewayWelcome,
  type DeviceHello,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceFilesystemReadCommand,
} from "@crewon/contracts";
import WebSocket, { type RawData } from "ws";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { DeviceCommandAuthorizationVerifierPort } from "./device-command-authorization-verifier.ts";
import type { AuthenticatedDeviceIdentity } from "./device-identity.ts";
import {
  DeviceGatewayWorkspaceSession,
  WORKSPACE_LIST_CAPABILITY,
  type WorkspaceSessionEventCommitter,
  type WorkspaceSessionExecutionMode,
} from "./device-gateway-workspace-session.ts";
import {
  DeviceGatewayWorkspaceReadSession,
  type WorkspaceReadEventCommitter,
} from "./device-gateway-workspace-read-session.ts";
import type { WorkspaceReadResolution } from "./workspace-read-dispatch-store.ts";

const MAX_DEVICE_FRAME_BYTES = 128 * 1024;
const MAX_EXECUTION_EVENTS = 4_096;
const NORMAL_CLOSE = 1000;
const POLICY_VIOLATION_CLOSE = 1008;

export type DeviceExecutionResolution = DeviceGatewayDispatchResolution;

type PendingExecution = {
  command: DeviceExecutionCommand;
  lastSequence: number;
  receiptId: string | null;
  accepted: boolean;
  outputBytes: number;
  output: Extract<DeviceExecutionEvent, { type: "execution.output" }>[];
  frames: Map<number, string>;
  timeout: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (resolution: DeviceExecutionResolution) => void;
};

type StartingExecution = {
  cancelReasonCode: string | null;
};

export class DeviceGatewaySession {
  readonly identity: AuthenticatedDeviceIdentity;
  readonly hello: DeviceHello;
  readonly #socket: WebSocket;
  readonly #now: () => Date;
  readonly #authorizationVerifier: DeviceCommandAuthorizationVerifierPort;
  readonly #workspace: DeviceGatewayWorkspaceSession;
  readonly #workspaceRead: DeviceGatewayWorkspaceReadSession;
  readonly #starting = new Map<string, StartingExecution>();
  readonly #pending = new Map<string, PendingExecution>();
  #closed = false;

  private constructor(config: {
    socket: WebSocket;
    identity: AuthenticatedDeviceIdentity;
    hello: DeviceHello;
    now: () => Date;
    authorizationVerifier: DeviceCommandAuthorizationVerifierPort;
  }) {
    this.#socket = config.socket;
    this.identity = structuredClone(config.identity);
    this.hello = structuredClone(config.hello);
    this.#now = config.now;
    this.#authorizationVerifier = config.authorizationVerifier;
    this.#workspace = new DeviceGatewayWorkspaceSession({
      deviceId: this.identity.deviceId,
      lastAcknowledged: this.hello.lastAcknowledged,
      now: this.#now,
      send: (value) => this.#send(value),
    });
    this.#workspaceRead = new DeviceGatewayWorkspaceReadSession({
      deviceId: this.identity.deviceId,
      now: this.#now,
      send: (value) => this.#send(value),
    });
    this.#socket.on("message", this.#onMessage);
    this.#socket.on("close", this.#onClose);
    this.#socket.on("error", this.#onError);
  }

  static async accept(config: {
    socket: WebSocket;
    identity:
      | AuthenticatedDeviceIdentity
      | Promise<AuthenticatedDeviceIdentity>;
    handshakeTimeoutMs?: number;
    now?: () => Date;
    authorizationVerifier: DeviceCommandAuthorizationVerifierPort;
  }): Promise<DeviceGatewaySession> {
    const helloPromise = receiveHello(
      config.socket,
      config.handshakeTimeoutMs ?? 10_000,
    );
    const identity = await config.identity;
    validateIdentity(identity);
    const hello = await helloPromise;
    if (hello.deviceId !== identity.deviceId) {
      if (config.socket.readyState === WebSocket.OPEN) {
        config.socket.close(
          POLICY_VIOLATION_CLOSE,
          "device_hello_identity_mismatch",
        );
      }
      throw new DeviceGatewayError("device_hello_identity_mismatch");
    }
    if (config.socket.readyState !== WebSocket.OPEN) {
      throw new DeviceGatewayError("device_session_closed");
    }
    return new DeviceGatewaySession({
      socket: config.socket,
      identity,
      hello,
      now: config.now ?? (() => new Date()),
      authorizationVerifier: config.authorizationVerifier,
    });
  }

  async execute(
    input: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceExecutionResolution> {
    this.#assertOpen();
    const command = parseDeviceExecutionCommand(input);
    this.#validateCommand(command);
    if (signal.aborted) {
      throw new DeviceGatewayError("device_execution_aborted_before_dispatch");
    }
    if (
      this.#starting.has(command.executionId) ||
      this.#pending.has(command.executionId)
    ) {
      throw new DeviceGatewayError("device_execution_already_pending");
    }
    const starting: StartingExecution = { cancelReasonCode: null };
    this.#starting.set(command.executionId, starting);
    try {
      await this.#authorizationVerifier.verify(command);
      this.#assertOpen();
      if (signal.aborted) {
        throw new DeviceGatewayError(
          "device_execution_aborted_before_dispatch",
        );
      }
      const expiresAt = Date.parse(command.expiresAt);
      const remainingMs = Math.min(
        expiresAt - this.#now().getTime(),
        command.limits.timeoutMs,
      );
      if (remainingMs <= 0) {
        throw new DeviceGatewayError("device_lease_expired");
      }

      return new Promise<DeviceExecutionResolution>((resolve) => {
        const timeout = setTimeout(
          () => {
            try {
              this.requestCancel(command.executionId, "execution_timeout");
            } catch {
              // The dispatched action still has an unknown outcome.
            }
            this.#finishUnknown(command.executionId);
          },
          Math.min(remainingMs, 2_147_483_647),
        );
        timeout.unref();
        const onAbort = () => {
          try {
            this.requestCancel(command.executionId, "caller_aborted");
          } catch {
            this.#finishUnknown(command.executionId);
          }
        };
        this.#pending.set(command.executionId, {
          command,
          lastSequence: 0,
          receiptId: null,
          accepted: false,
          outputBytes: 0,
          output: [],
          frames: new Map(),
          timeout,
          signal,
          onAbort,
          resolve,
        });
        this.#starting.delete(command.executionId);
        signal.addEventListener("abort", onAbort, { once: true });
        void this.#send(command).then(
          () => {
            if (starting.cancelReasonCode !== null) {
              try {
                this.requestCancel(
                  command.executionId,
                  starting.cancelReasonCode,
                );
              } catch {
                this.#finishUnknown(command.executionId);
              }
            }
          },
          () => {
            signal.removeEventListener("abort", onAbort);
            this.#finishUnknown(command.executionId);
          },
        );
      });
    } catch (error) {
      if (this.#starting.get(command.executionId) === starting) {
        this.#starting.delete(command.executionId);
      }
      throw error;
    }
  }

  acknowledgedSequence(executionId: string): number | null {
    const acknowledged = this.hello.lastAcknowledged.find(
      (value) => value.executionId === executionId,
    );
    return acknowledged?.sequence ?? null;
  }

  supportsWorkspaceList(): boolean {
    return this.hello.capabilities.includes(WORKSPACE_LIST_CAPABILITY);
  }

  supportsWorkspaceRead(): boolean {
    return this.hello.capabilities.includes("workspace.read_file.v0");
  }

  executeWorkspaceRead(
    command: DeviceFilesystemReadCommand,
    connectionEpoch: number,
    replay: boolean,
    signal: AbortSignal,
    commit: WorkspaceReadEventCommitter,
  ): Promise<WorkspaceReadResolution> {
    if (!this.supportsWorkspaceRead())
      throw new DeviceGatewayError("device_capability_unavailable");
    return this.#workspaceRead.execute(
      command,
      connectionEpoch,
      replay,
      signal,
      commit,
    );
  }

  setWorkspaceReadOrphanEventCommitter(
    committer: WorkspaceReadEventCommitter | null,
  ): void {
    this.#workspaceRead.setOrphanCommitter(committer);
  }

  executeWorkspaceList(
    command: DeviceWorkspaceListCommand,
    connectionEpoch: number,
    mode: WorkspaceSessionExecutionMode,
    signal: AbortSignal,
    commit: WorkspaceSessionEventCommitter,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    if (!this.supportsWorkspaceList()) {
      throw new DeviceGatewayError("device_capability_unavailable");
    }
    return this.#workspace.execute(
      command,
      connectionEpoch,
      mode,
      signal,
      commit,
    );
  }

  workspaceAcknowledgedSequence(executionId: string): number | null {
    return this.#workspace.acknowledgedSequence(executionId);
  }

  requestWorkspaceCancel(executionId: string, reasonCode: string): void {
    this.#workspace.requestCancel(executionId, reasonCode);
  }

  setWorkspaceOrphanEventCommitter(
    committer: WorkspaceSessionEventCommitter | null,
  ): void {
    this.#workspace.setOrphanCommitter(committer);
  }

  isClosed(): boolean {
    return this.#closed || this.#socket.readyState !== WebSocket.OPEN;
  }

  async establishConnectionEpoch(input: DeviceGatewayWelcome): Promise<void> {
    this.#assertOpen();
    const welcome = parseDeviceGatewayWelcome(input);
    if (
      welcome.deviceId !== this.identity.deviceId ||
      welcome.connectionId !== this.hello.connectionId
    ) {
      throw new DeviceGatewayError("device_welcome_identity_mismatch");
    }
    await this.#send(welcome);
  }

  requestCancel(executionId: string, reasonCode: string): void {
    this.#assertOpen();
    if (!/^[a-z0-9_.:-]{1,128}$/.test(reasonCode)) {
      throw new DeviceGatewayError("device_cancel_reason_invalid");
    }
    const pending = this.#pending.get(executionId);
    if (pending === undefined) {
      const starting = this.#starting.get(executionId);
      if (starting !== undefined) {
        starting.cancelReasonCode ??= reasonCode;
        return;
      }
      throw new DeviceGatewayError("device_execution_not_pending");
    }
    const cancel: DeviceExecutionCancel = {
      schemaVersion: "crewon.device-cancel.v0",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      deviceId: this.identity.deviceId,
      executionId,
      leaseId: pending.command.leaseId,
      leaseEpoch: pending.command.leaseEpoch,
      reasonCode,
      requestedAt: this.#now().toISOString(),
    };
    void this.#send(cancel).catch(() => this.#finishUnknown(executionId));
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#socket.close(NORMAL_CLOSE, "gateway_shutdown");
    this.#handleClose();
  }

  readonly #onMessage = (data: RawData, isBinary: boolean): void => {
    void this.#handleMessage(data, isBinary).catch((error: unknown) => {
      this.#protocolFailure(error);
    });
  };

  readonly #onClose = (): void => {
    this.#handleClose();
  };

  readonly #onError = (): void => {
    this.#handleClose();
  };

  async #handleMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      throw new DeviceGatewayError("device_binary_frame_unsupported");
    }
    const encoded = rawDataBuffer(data);
    if (encoded.byteLength > MAX_DEVICE_FRAME_BYTES) {
      throw new DeviceGatewayError("device_frame_too_large");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded.toString("utf8"));
    } catch (error) {
      throw new DeviceGatewayError("device_frame_json_invalid", {
        cause: error,
      });
    }
    if (await this.#workspace.handleFrame(decoded)) return;
    if (await this.#workspaceRead.handleFrame(decoded)) return;
    const event = parseDeviceExecutionEvent(decoded);
    if (event.deviceId !== this.identity.deviceId) {
      throw new DeviceGatewayError("device_event_identity_mismatch");
    }
    const pending = this.#pending.get(event.executionId);
    if (pending === undefined) {
      throw new DeviceGatewayError("device_execution_unknown");
    }
    const canonical = JSON.stringify(event);
    if (event.sequence <= pending.lastSequence) {
      if (pending.frames.get(event.sequence) !== canonical) {
        throw new DeviceGatewayError("device_event_replay_mismatch");
      }
      await this.#ack(event);
      return;
    }
    if (
      event.sequence !== pending.lastSequence + 1 ||
      event.sequence > MAX_EXECUTION_EVENTS
    ) {
      throw new DeviceGatewayError("device_event_sequence_gap");
    }
    if (pending.receiptId !== null && pending.receiptId !== event.receiptId) {
      throw new DeviceGatewayError("device_receipt_changed");
    }
    if (!pending.accepted) {
      if (
        event.type !== "execution.accepted" ||
        event.data.leaseEpoch !== pending.command.leaseEpoch ||
        event.data.actionDigest !== pending.command.actionDigest
      ) {
        throw new DeviceGatewayError("device_acceptance_mismatch");
      }
      pending.accepted = true;
      pending.receiptId = event.receiptId;
    } else if (event.type === "execution.accepted") {
      throw new DeviceGatewayError("device_acceptance_repeated");
    }
    if (event.type === "execution.output") {
      pending.outputBytes += new TextEncoder().encode(
        event.data.chunk,
      ).byteLength;
      if (pending.outputBytes > pending.command.limits.maxOutputBytes) {
        throw new DeviceGatewayError("device_output_limit_exceeded");
      }
      pending.output.push(event);
    }
    if (event.type === "execution.completed" && event.data.output !== null) {
      const terminalOutputBytes = new TextEncoder().encode(
        event.data.output,
      ).byteLength;
      if (
        pending.outputBytes + terminalOutputBytes >
        pending.command.limits.maxOutputBytes
      ) {
        throw new DeviceGatewayError("device_output_limit_exceeded");
      }
    }
    if (event.type === "execution.completed") {
      const stdout = pending.output
        .filter((output) => output.data.channel === "stdout")
        .map((output) => output.data.chunk)
        .join("");
      const stderr = pending.output
        .filter((output) => output.data.channel === "stderr")
        .map((output) => output.data.chunk)
        .join("");
      if (
        sha256(stdout) !== event.data.stdoutDigest ||
        sha256(stderr) !== event.data.stderrDigest ||
        (event.data.output !== null &&
          sha256(event.data.output) !== event.data.outputDigest)
      ) {
        throw new DeviceGatewayError("device_output_digest_mismatch");
      }
    }
    pending.lastSequence = event.sequence;
    pending.frames.set(event.sequence, canonical);
    await this.#ack(event);
    this.#resolveTerminal(pending, event);
  }

  #resolveTerminal(
    pending: PendingExecution,
    event: DeviceExecutionEvent,
  ): void {
    if (
      event.type === "execution.accepted" ||
      event.type === "execution.output"
    ) {
      return;
    }
    this.#pending.delete(event.executionId);
    cleanupPendingExecution(pending);
    if (event.type === "execution.completed") {
      pending.resolve({
        status: "completed",
        executionId: event.executionId,
        providerReceiptId: event.receiptId,
        terminal: event,
        output: structuredClone(pending.output),
      });
      return;
    }
    if (event.type === "execution.failed") {
      pending.resolve({
        status: "failed",
        executionId: event.executionId,
        providerReceiptId: event.receiptId,
        terminal: event,
      });
      return;
    }
    if (event.type === "execution.canceled") {
      pending.resolve({
        status: "canceled",
        executionId: event.executionId,
        providerReceiptId: event.receiptId,
        terminal: event,
      });
      return;
    }
    pending.resolve({
      status: "unknownOutcome",
      executionId: event.executionId,
      providerReceiptId: event.data.providerReceiptId ?? event.receiptId,
      terminal: event,
    });
  }

  async #ack(event: DeviceExecutionEvent): Promise<void> {
    const ack: DeviceExecutionAck = {
      schemaVersion: "crewon.device-ack.v0",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      deviceId: this.identity.deviceId,
      executionId: event.executionId,
      throughSequence: event.sequence,
      acknowledgedAt: this.#now().toISOString(),
    };
    await this.#send(ack);
  }

  #finishUnknown(executionId: string): void {
    const pending = this.#pending.get(executionId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(executionId);
    cleanupPendingExecution(pending);
    pending.resolve({
      status: "unknownOutcome",
      executionId,
      providerReceiptId: pending.receiptId,
      terminal: null,
    });
  }

  #protocolFailure(error: unknown): void {
    if (!this.#closed && this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(
        POLICY_VIOLATION_CLOSE,
        error instanceof DeviceGatewayError
          ? error.code.slice(0, 123)
          : "device_protocol_error",
      );
    }
    this.#handleClose();
  }

  #handleClose(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#socket.off("message", this.#onMessage);
    this.#socket.off("close", this.#onClose);
    this.#socket.off("error", this.#onError);
    this.#workspace.close();
    this.#workspaceRead.close();
    for (const executionId of [...this.#pending.keys()]) {
      this.#finishUnknown(executionId);
    }
  }

  #validateCommand(command: DeviceExecutionCommand): void {
    if (command.deviceId !== this.identity.deviceId) {
      throw new DeviceGatewayError("device_command_identity_mismatch");
    }
    if (!this.hello.capabilities.includes(command.capability)) {
      throw new DeviceGatewayError("device_capability_unavailable");
    }
  }

  #send(value: object): Promise<void> {
    this.#assertOpen();
    return new Promise<void>((resolve, reject) => {
      this.#socket.send(JSON.stringify(value), (error) => {
        if (error === undefined || error === null) {
          resolve();
        } else {
          reject(
            new DeviceGatewayError("device_frame_send_failed", {
              cause: error,
            }),
          );
        }
      });
    });
  }

  #assertOpen(): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new DeviceGatewayError("device_session_closed");
    }
  }
}

async function receiveHello(
  socket: WebSocket,
  timeoutMs: number,
): Promise<DeviceHello> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new DeviceGatewayError("device_handshake_timeout_invalid");
  }
  return new Promise<DeviceHello>((resolve, reject) => {
    const timeout = setTimeout(() => fail("device_hello_timeout"), timeoutMs);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const fail = (code: string, cause?: unknown) => {
      cleanup();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(POLICY_VIOLATION_CLOSE, code.slice(0, 123));
      }
      reject(new DeviceGatewayError(code, { cause }));
    };
    const onClose = () => fail("device_closed_before_hello");
    const onError = (error: Error) =>
      fail("device_hello_transport_error", error);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        fail("device_binary_frame_unsupported");
        return;
      }
      const encoded = rawDataBuffer(data);
      if (encoded.byteLength > MAX_DEVICE_FRAME_BYTES) {
        fail("device_frame_too_large");
        return;
      }
      try {
        const hello = parseDeviceHello(JSON.parse(encoded.toString("utf8")));
        cleanup();
        resolve(hello);
      } catch (error) {
        fail("device_hello_invalid", error);
      }
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function validateIdentity(identity: AuthenticatedDeviceIdentity): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(identity.deviceId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(identity.credentialId) ||
    (identity.authenticationMethod !== "mtls" &&
      identity.authenticationMethod !== "deviceKey") ||
    Number.isNaN(Date.parse(identity.authenticatedAt)) ||
    !identity.authenticatedAt.endsWith("Z")
  ) {
    throw new DeviceGatewayError("device_authenticated_identity_invalid");
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function cleanupPendingExecution(pending: PendingExecution): void {
  clearTimeout(pending.timeout);
  pending.signal.removeEventListener("abort", pending.onAbort);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
