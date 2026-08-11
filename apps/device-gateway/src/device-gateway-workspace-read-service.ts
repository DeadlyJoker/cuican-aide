import {
  parseDeviceFilesystemReadCommand,
  parseDeviceFilesystemReadDispatchReference,
  type DeviceFilesystemReadDispatchReference,
  type DeviceFilesystemReadRouteIntent,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadEvent,
} from "@crewon/contracts";

import type { DeviceGatewaySession } from "./device-gateway-session.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { WorkspaceWorkerIdentity } from "./worker-identity.ts";
import type { WorkspaceWorkerRuntimeAuthorizerPort } from "./workspace-worker-runtime-authorizer.ts";
import {
  workspaceReadFingerprint,
  type WorkspaceReadDispatchRecord,
  type WorkspaceReadDispatchStorePort,
  type WorkspaceReadResolution,
  type WorkspaceReadRouteFence,
} from "./workspace-read-dispatch-store.ts";

export type WorkspaceReadSessionTarget = Readonly<{
  session: DeviceGatewaySession;
  route: WorkspaceReadRouteFence;
}>;

export interface WorkspaceReadSessionRegistryPort {
  workspaceReadSession(
    deviceId: string,
    intent?: DeviceFilesystemReadRouteIntent,
  ): WorkspaceReadSessionTarget | null;
  setWorkspaceReadOrphanEventCommitter?(
    committer:
      | ((
          event: DeviceFilesystemReadEvent,
        ) => ReturnType<WorkspaceReadDispatchStorePort["commit"]>)
      | null,
  ): void;
}

export interface WorkspaceReadCommandVerifierPort {
  verify(command: DeviceFilesystemReadCommand): Promise<void>;
}

type Active = {
  fingerprint: string;
  controller: AbortController;
  promise: Promise<WorkspaceReadResolution>;
};

/** Internal Worker-to-Device durable workspace-read coordinator. */
export class DeviceGatewayWorkspaceReadService {
  readonly #sessions: WorkspaceReadSessionRegistryPort;
  readonly #workers: WorkspaceWorkerRuntimeAuthorizerPort;
  readonly #verifier: WorkspaceReadCommandVerifierPort;
  readonly #store: WorkspaceReadDispatchStorePort;
  readonly #now: () => Date;
  readonly #active = new Map<string, Active>();
  #closed = false;

  constructor(config: {
    sessions: WorkspaceReadSessionRegistryPort;
    workers: WorkspaceWorkerRuntimeAuthorizerPort;
    verifier: WorkspaceReadCommandVerifierPort;
    store: WorkspaceReadDispatchStorePort;
    now?: () => Date;
  }) {
    this.#sessions = config.sessions;
    this.#workers = config.workers;
    this.#verifier = config.verifier;
    this.#store = config.store;
    this.#now = config.now ?? (() => new Date());
    this.#sessions.setWorkspaceReadOrphanEventCommitter?.((event) =>
      this.#commitOrphan(event),
    );
  }

  async execute(
    worker: WorkspaceWorkerIdentity,
    intentInput: string | DeviceFilesystemReadRouteIntent,
    input: DeviceFilesystemReadCommand,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<WorkspaceReadResolution> {
    if (this.#closed) throw new DeviceGatewayError("workspace_read_closed");
    const command = parseDeviceFilesystemReadCommand(input);
    const intent = readIntent(intentInput);
    const runtimeBindingId = intent.runtimeBindingId;
    this.#workers.authorize(worker, runtimeBindingId);
    if (signal.aborted) throw new DeviceGatewayError("workspace_read_not_sent");
    const prior = await this.#store.load(command.executionId);
    if (prior !== null) {
      this.#requireMatch(prior, command);
      if (prior.resolution !== null) return structuredClone(prior.resolution);
      return this.#start(prior, true, intent, signal);
    }
    await this.#verifier.verify(command);
    const target = this.#sessions.workspaceReadSession(
      command.deviceId,
      intent,
    );
    if (target === null) throw new DeviceGatewayError("device_unavailable");
    if (
      target.route.runtimeBindingId !== runtimeBindingId ||
      target.route.deviceBindingId !== intent.deviceBindingId
    )
      throw new DeviceGatewayError("workspace_read_route_stale");
    const prepared = await this.#store.prepare(
      command,
      target.route,
      this.#timestamp(),
    );
    if (prepared.record.resolution !== null)
      return structuredClone(prepared.record.resolution);
    return this.#start(
      prepared.record,
      prepared.outcome === "existing",
      intent,
      signal,
    );
  }

  async reconcile(
    worker: WorkspaceWorkerIdentity,
    intentInput: string | DeviceFilesystemReadRouteIntent,
    input: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<WorkspaceReadResolution> {
    if (this.#closed) throw new DeviceGatewayError("workspace_read_closed");
    const reference = parseDeviceFilesystemReadDispatchReference(input);
    const intent = readIntent(intentInput, reference.deviceBindingId);
    const runtimeBindingId = intent.runtimeBindingId;
    this.#workers.authorize(worker, runtimeBindingId);
    const record = await this.#store.load(reference.executionId);
    if (record === null)
      return unknown(reference.executionId, reference.receiptId);
    this.#requireReference(record, reference, runtimeBindingId);
    if (record.resolution !== null) return structuredClone(record.resolution);
    return this.#start(record, true, intent, signal);
  }

  async cancel(
    worker: WorkspaceWorkerIdentity,
    intentInput: string | DeviceFilesystemReadRouteIntent,
    input: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<WorkspaceReadResolution> {
    const reference = parseDeviceFilesystemReadDispatchReference(input);
    const intent = readIntent(intentInput, reference.deviceBindingId);
    if (this.#closed) throw new DeviceGatewayError("workspace_read_closed");
    this.#workers.authorize(worker, intent.runtimeBindingId);
    if (signal.aborted) throw new DeviceGatewayError("workspace_read_not_sent");
    const record = await this.#store.load(reference.executionId);
    if (record === null)
      return unknown(reference.executionId, reference.receiptId);
    this.#requireReference(record, reference, intent.runtimeBindingId);
    if (record.resolution !== null) return structuredClone(record.resolution);
    if (record.acceptedEvent?.type === "workspace_read.accepted") {
      if (
        record.acceptedEvent.data.leaseId !== reference.leaseId ||
        record.acceptedEvent.data.leaseEpoch !== reference.leaseEpoch ||
        record.acceptedEvent.receiptId !== reference.receiptId
      )
        throw new DeviceGatewayError("workspace_read_identity_conflict");
      const target = this.#sessions.workspaceReadSession(
        record.command.deviceId,
        intent,
      );
      if (target !== null) {
        try {
          target.session.requestWorkspaceReadCancel(
            reference.executionId,
            "worker_cancel_requested",
          );
        } catch {
          // The frozen receipt remains the only outcome authority.
        }
      }
    }
    return (
      this.#active.get(reference.executionId)?.promise ??
      unknown(reference.executionId, record.acceptedEvent?.receiptId ?? null)
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#sessions.setWorkspaceReadOrphanEventCommitter?.(null);
    for (const active of this.#active.values())
      active.controller.abort("workspace_read_shutdown");
    await Promise.allSettled(
      [...this.#active.values()].map((active) => active.promise),
    );
  }

  #start(
    record: WorkspaceReadDispatchRecord,
    replay: boolean,
    intentInput: string | DeviceFilesystemReadRouteIntent,
    signal: AbortSignal,
  ): Promise<WorkspaceReadResolution> {
    const existing = this.#active.get(record.executionId);
    if (existing !== undefined) {
      if (existing.fingerprint !== record.fingerprint)
        throw new DeviceGatewayError("workspace_read_identity_conflict");
      return existing.promise;
    }
    const intent = readIntent(intentInput, record.route?.deviceBindingId);
    const runtimeBindingId = intent.runtimeBindingId;
    const target = this.#sessions.workspaceReadSession(
      record.command.deviceId,
      intent,
    );
    if (target === null) throw new DeviceGatewayError("device_unavailable");
    if (!target.session.supportsWorkspaceRead())
      throw new DeviceGatewayError("device_capability_unavailable");
    if (
      target.route.runtimeBindingId !== runtimeBindingId ||
      target.route.deviceId !== record.command.deviceId ||
      target.route.capability !== "workspace.read_file.v0"
    )
      throw new DeviceGatewayError("workspace_read_route_stale");
    const route = record.route ?? target.route;
    if (
      record.route !== null &&
      JSON.stringify(record.route) !== JSON.stringify(target.route)
    ) {
      // Reconnect recovery retains the accepted fence; only the new transport changes.
      if (record.acceptedEvent === null)
        throw new DeviceGatewayError("workspace_read_route_stale");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const active: Active = {
      fingerprint: record.fingerprint,
      controller,
      promise: Promise.resolve(unknown(record.executionId, null)),
    };
    active.promise = target.session
      .executeWorkspaceRead(
        record.command,
        route.connectionEpoch,
        replay,
        controller.signal,
        (event) =>
          this.#store.commit({ command: record.command, route, event }),
      )
      .finally(() => {
        signal.removeEventListener("abort", abort);
        if (this.#active.get(record.executionId) === active)
          this.#active.delete(record.executionId);
      });
    this.#active.set(record.executionId, active);
    return active.promise;
  }

  async #commitOrphan(event: DeviceFilesystemReadEvent) {
    const record = await this.#store.load(event.executionId);
    if (record === null || record.route === null)
      throw new DeviceGatewayError("device_execution_unknown");
    return this.#store.commit({
      command: record.command,
      route: record.route,
      event,
    });
  }

  #requireMatch(
    record: WorkspaceReadDispatchRecord,
    command: DeviceFilesystemReadCommand,
  ) {
    if (
      record.route === null ||
      record.fingerprint !== workspaceReadFingerprint(command, record.route)
    )
      throw new DeviceGatewayError("workspace_read_identity_conflict");
  }
  #requireReference(
    record: WorkspaceReadDispatchRecord,
    reference: DeviceFilesystemReadDispatchReference,
    runtimeBindingId: string,
  ) {
    const command = record.command;
    if (
      record.route === null ||
      runtimeBindingId !== reference.runtimeBindingId ||
      command.deviceId !== reference.deviceId ||
      command.executionId !== reference.executionId ||
      command.workspaceBindingId !== reference.workspaceBindingId ||
      command.arguments.workspaceIncarnationId !== reference.incarnationId ||
      record.route.deviceBindingId !== reference.deviceBindingId ||
      record.route.runtimeBindingId !== reference.runtimeBindingId ||
      command.actionDigest !== reference.actionDigest ||
      command.leaseId !== reference.leaseId ||
      command.leaseEpoch !== reference.leaseEpoch ||
      canonicalDeviceFilesystemReadCommandDigest(command, digestUtf8) !==
        reference.commandDigest ||
      (reference.receiptId !== null &&
        record.acceptedEvent?.receiptId !== reference.receiptId)
    )
      throw new DeviceGatewayError("workspace_read_identity_conflict");
  }
  #timestamp() {
    const now = this.#now();
    if (!Number.isFinite(now.getTime()))
      throw new DeviceGatewayError("workspace_read_clock_invalid");
    return now.toISOString();
  }
}

function readIntent(
  input: string | DeviceFilesystemReadRouteIntent,
  deviceBindingId = "legacy-device-binding",
): DeviceFilesystemReadRouteIntent {
  return typeof input === "string"
    ? { deviceBindingId, runtimeBindingId: input }
    : input;
}

import { canonicalDeviceFilesystemReadCommandDigest } from "@crewon/contracts";
import { createHash } from "node:crypto";
function digestUtf8(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function unknown(
  executionId: string,
  receiptId: string | null,
): WorkspaceReadResolution {
  return { status: "unknownOutcome", executionId, receiptId, terminal: null };
}
