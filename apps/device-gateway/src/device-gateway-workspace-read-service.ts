import {
  parseDeviceFilesystemReadCommand,
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
  workspaceReadSession(deviceId: string): WorkspaceReadSessionTarget | null;
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
    runtimeBindingId: string,
    input: DeviceFilesystemReadCommand,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<WorkspaceReadResolution> {
    if (this.#closed) throw new DeviceGatewayError("workspace_read_closed");
    const command = parseDeviceFilesystemReadCommand(input);
    this.#workers.authorize(worker, runtimeBindingId);
    if (signal.aborted) throw new DeviceGatewayError("workspace_read_not_sent");
    const prior = await this.#store.load(command.executionId);
    if (prior !== null) {
      this.#requireMatch(prior, command);
      if (prior.resolution !== null) return structuredClone(prior.resolution);
      return this.#start(prior, true, runtimeBindingId, signal);
    }
    await this.#verifier.verify(command);
    const target = this.#sessions.workspaceReadSession(command.deviceId);
    if (target === null || target.route.runtimeBindingId !== runtimeBindingId)
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
      runtimeBindingId,
      signal,
    );
  }

  async reconcile(
    worker: WorkspaceWorkerIdentity,
    runtimeBindingId: string,
    input: DeviceFilesystemReadCommand,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<WorkspaceReadResolution> {
    if (this.#closed) throw new DeviceGatewayError("workspace_read_closed");
    const command = parseDeviceFilesystemReadCommand(input);
    this.#workers.authorize(worker, runtimeBindingId);
    const record = await this.#store.load(command.executionId);
    if (record === null) return unknown(command.executionId, null);
    this.#requireMatch(record, command);
    if (record.resolution !== null) return structuredClone(record.resolution);
    return this.#start(record, true, runtimeBindingId, signal);
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
    runtimeBindingId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceReadResolution> {
    const existing = this.#active.get(record.executionId);
    if (existing !== undefined) {
      if (existing.fingerprint !== record.fingerprint)
        throw new DeviceGatewayError("workspace_read_identity_conflict");
      return existing.promise;
    }
    const target = this.#sessions.workspaceReadSession(record.command.deviceId);
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
  #timestamp() {
    const now = this.#now();
    if (!Number.isFinite(now.getTime()))
      throw new DeviceGatewayError("workspace_read_clock_invalid");
    return now.toISOString();
  }
}

function unknown(
  executionId: string,
  receiptId: string | null,
): WorkspaceReadResolution {
  return { status: "unknownOutcome", executionId, receiptId, terminal: null };
}
