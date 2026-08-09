import {
  parseDeviceExecutionCommand,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import type { DeviceCommandAuthorizationVerifierPort } from "./device-command-authorization-verifier.ts";
import { deviceDispatchFingerprint } from "./device-dispatch-identity.ts";
import {
  InMemoryDeviceDispatchStore,
  type DeviceDispatchAuthorityRecord,
  type DeviceDispatchStorePort,
} from "./device-dispatch-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

type DeviceExecutionSessionPort = Readonly<{
  acknowledgedSequence(executionId: string): number | null;
  execute(
    command: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceGatewayDispatchResolution>;
  requestCancel(executionId: string, reasonCode: string): void;
}>;

type DeviceSessionRegistryPort = Readonly<{
  session(deviceId: string): DeviceExecutionSessionPort | null;
}>;

type DispatchRecord = {
  fingerprint: string;
  deviceId: string;
  controller: AbortController;
  promise: Promise<DeviceGatewayDispatchResolution>;
  resolution: DeviceGatewayDispatchResolution | null;
  resolvedAtMs: number | null;
};

/** Keeps an execution alive across Worker request loss without owning Run authority. */
export class DeviceGatewayDispatchService {
  readonly #sessions: DeviceSessionRegistryPort;
  readonly #authorizationVerifier: DeviceCommandAuthorizationVerifierPort;
  readonly #store: DeviceDispatchStorePort;
  readonly #now: () => Date;
  readonly #maxRecords: number;
  readonly #terminalTtlMs: number;
  readonly #records = new Map<string, DispatchRecord>();
  #closed = false;

  constructor(config: {
    sessions: DeviceSessionRegistryPort;
    authorizationVerifier: DeviceCommandAuthorizationVerifierPort;
    store?: DeviceDispatchStorePort;
    now?: () => Date;
    maxRecords?: number;
    terminalTtlMs?: number;
  }) {
    this.#sessions = config.sessions;
    this.#authorizationVerifier = config.authorizationVerifier;
    this.#store = config.store ?? new InMemoryDeviceDispatchStore();
    this.#now = config.now ?? (() => new Date());
    this.#maxRecords = boundedPositiveInteger(
      config.maxRecords ?? 10_000,
      100_000,
      "device_dispatch_record_limit_invalid",
    );
    this.#terminalTtlMs = boundedPositiveInteger(
      config.terminalTtlMs ?? 3_600_000,
      24 * 60 * 60 * 1_000,
      "device_dispatch_terminal_ttl_invalid",
    );
  }

  async execute(
    input: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    this.#assertOpen();
    const command = await this.#authorizedCommand(input);
    this.#evictExpired();
    const prior = this.#matchingRecord(command);
    if (prior !== null) {
      return prior.promise;
    }
    const durable = await this.#matchingDurableRecord(command);
    if (durable !== null) {
      return durable.resolution === null
        ? this.#resumePrepared(durable)
        : structuredClone(durable.resolution);
    }
    if (this.#records.size >= this.#maxRecords) {
      throw new DeviceGatewayError("device_dispatch_capacity_exceeded");
    }
    const session = this.#sessions.session(command.deviceId);
    if (session === null) {
      throw new DeviceGatewayError("device_unavailable");
    }
    const prepared = await this.#store.prepare(
      command,
      this.#now().toISOString(),
    );
    if (prepared.outcome === "existing") {
      return prepared.record.resolution === null
        ? this.#resumePrepared(prepared.record)
        : structuredClone(prepared.record.resolution);
    }
    return this.#startSessionExecution(command, session);
  }

  async reconcile(
    input: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    this.#assertOpen();
    const command = await this.#authorizedCommand(input);
    this.#evictExpired();
    const record = this.#matchingRecord(command);
    if (record !== null) {
      return record.promise;
    }
    const durable = await this.#matchingDurableRecord(command);
    return durable === null || durable.resolution === null
      ? durable === null
        ? unknownResolution(command.executionId)
        : this.#resumePrepared(durable)
      : structuredClone(durable.resolution);
  }

  async cancel(
    input: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    this.#assertOpen();
    const command = await this.#authorizedCommand(input);
    this.#evictExpired();
    let record = this.#matchingRecord(command);
    if (record === null) {
      const durable = await this.#matchingDurableRecord(command);
      if (durable === null || durable.resolution !== null) {
        return durable?.resolution === undefined || durable.resolution === null
          ? unknownResolution(command.executionId)
          : structuredClone(durable.resolution);
      }
      const promise = this.#resumePrepared(durable);
      record = this.#matchingRecord(command);
      if (record === null) {
        return promise;
      }
    }
    if (record.resolution !== null) {
      return structuredClone(record.resolution);
    }
    try {
      this.#sessions
        .session(record.deviceId)
        ?.requestCancel(command.executionId, "worker_cancel_requested");
    } catch {
      // The active execution promise will settle canceled or unknown.
    }
    return record.promise;
  }

  #startSessionExecution(
    command: DeviceExecutionCommand,
    session: DeviceExecutionSessionPort,
  ): Promise<DeviceGatewayDispatchResolution> {
    const controller = new AbortController();
    const record: DispatchRecord = {
      fingerprint: deviceDispatchFingerprint(command),
      deviceId: command.deviceId,
      controller,
      promise: Promise.resolve({
        status: "unknownOutcome",
        executionId: command.executionId,
        providerReceiptId: null,
        terminal: null,
      }),
      resolution: null,
      resolvedAtMs: null,
    };
    record.promise = session
      .execute(command, controller.signal)
      .then(async (resolution) => {
        if (transientUnknown(resolution)) {
          this.#records.delete(command.executionId);
          return structuredClone(resolution);
        }
        await this.#store.complete(
          command,
          resolution,
          this.#now().toISOString(),
        );
        record.resolution = structuredClone(resolution);
        record.resolvedAtMs = this.#now().getTime();
        return structuredClone(resolution);
      })
      .catch((error: unknown) => {
        if (this.#records.get(command.executionId) === record) {
          this.#records.delete(command.executionId);
        }
        throw error;
      });
    this.#records.set(command.executionId, record);
    return record.promise;
  }

  #resumePrepared(
    durable: DeviceDispatchAuthorityRecord,
  ): Promise<DeviceGatewayDispatchResolution> {
    const command = durable.command;
    const nowMs = this.#now().getTime();
    if (
      !Number.isFinite(nowMs) ||
      Date.parse(command.expiresAt) <= nowMs ||
      Date.parse(command.authorization.expiresAt) <= nowMs
    ) {
      return Promise.resolve(unknownResolution(command.executionId));
    }
    const session = this.#sessions.session(command.deviceId);
    if (
      session === null ||
      session.acknowledgedSequence(command.executionId) === null
    ) {
      return Promise.resolve(unknownResolution(command.executionId));
    }
    if (this.#records.size >= this.#maxRecords) {
      throw new DeviceGatewayError("device_dispatch_capacity_exceeded");
    }
    return this.#startSessionExecution(command, session);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const active: Promise<DeviceGatewayDispatchResolution>[] = [];
    for (const record of this.#records.values()) {
      if (record.resolution === null) {
        active.push(record.promise);
        record.controller.abort("gateway_dispatch_shutdown");
      }
    }
    await Promise.allSettled(active);
    this.#records.clear();
  }

  async #authorizedCommand(
    input: DeviceExecutionCommand,
  ): Promise<DeviceExecutionCommand> {
    const command = parseDeviceExecutionCommand(input);
    await this.#authorizationVerifier.verify(command);
    return command;
  }

  #matchingRecord(command: DeviceExecutionCommand): DispatchRecord | null {
    const prior = this.#records.get(command.executionId);
    if (prior === undefined) {
      return null;
    }
    if (prior.fingerprint !== deviceDispatchFingerprint(command)) {
      throw new DeviceGatewayError("device_dispatch_identity_conflict");
    }
    return prior;
  }

  async #matchingDurableRecord(
    command: DeviceExecutionCommand,
  ): Promise<DeviceDispatchAuthorityRecord | null> {
    const record = await this.#store.load(command.executionId);
    if (
      record !== null &&
      record.fingerprint !== deviceDispatchFingerprint(command)
    ) {
      throw new DeviceGatewayError("device_dispatch_identity_conflict");
    }
    return record;
  }

  #evictExpired(): void {
    const nowMs = this.#now().getTime();
    if (!Number.isFinite(nowMs)) {
      throw new DeviceGatewayError("device_dispatch_clock_invalid");
    }
    for (const [executionId, record] of this.#records) {
      if (
        record.resolvedAtMs !== null &&
        nowMs - record.resolvedAtMs >= this.#terminalTtlMs
      ) {
        this.#records.delete(executionId);
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("device_dispatch_closed");
    }
  }
}

function unknownResolution(
  executionId: string,
): DeviceGatewayDispatchResolution {
  return {
    status: "unknownOutcome",
    executionId,
    providerReceiptId: null,
    terminal: null,
  };
}

function transientUnknown(
  resolution: DeviceGatewayDispatchResolution,
): boolean {
  return resolution.status === "unknownOutcome" && resolution.terminal === null;
}

function boundedPositiveInteger(
  value: number,
  max: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new DeviceGatewayError(code);
  }
  return value;
}
