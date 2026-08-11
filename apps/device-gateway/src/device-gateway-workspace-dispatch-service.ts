import {
  parseDeviceWorkspaceListCommand,
  parseDeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceWorkspaceListEvent,
  type DeviceWorkspaceListPeerRoute,
} from "@crewon/contracts";

import type { DeviceGatewaySession } from "./device-gateway-session.ts";
import type { WorkspaceSessionEventCommitter } from "./device-gateway-workspace-session.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { WorkspaceWorkerIdentity } from "./worker-identity.ts";
import type { WorkspaceCommandAuthorizationVerifierPort } from "./workspace-command-authorization-verifier.ts";
import {
  workspaceDispatchFingerprint,
  type WorkspaceDispatchAuthorityRecord,
  type WorkspaceDispatchStorePort,
} from "./workspace-dispatch-store.ts";
import type { WorkspaceWorkerRuntimeAuthorizerPort } from "./workspace-worker-runtime-authorizer.ts";

export type WorkspaceDeviceSessionTarget = Readonly<{
  session: DeviceGatewaySession;
  route: DeviceWorkspaceListPeerRoute;
}>;

export interface WorkspaceDeviceSessionRegistryPort {
  workspaceSession(deviceId: string): WorkspaceDeviceSessionTarget | null;
  setWorkspaceOrphanEventCommitter?(
    committer: WorkspaceSessionEventCommitter | null,
  ): void;
}

type ActiveWorkspaceDispatch = {
  fingerprint: string;
  session: DeviceGatewaySession;
  controller: AbortController;
  promise: Promise<DeviceWorkspaceListDispatchResolution>;
};

/** Coordinates receipt-first Workspace dispatch without owning application state. */
export class DeviceGatewayWorkspaceDispatchService {
  readonly #sessions: WorkspaceDeviceSessionRegistryPort;
  readonly #authorizationVerifier: WorkspaceCommandAuthorizationVerifierPort;
  readonly #workerAuthorizer: WorkspaceWorkerRuntimeAuthorizerPort;
  readonly #store: WorkspaceDispatchStorePort;
  readonly #now: () => Date;
  readonly #active = new Map<string, ActiveWorkspaceDispatch>();
  #closed = false;

  constructor(config: {
    sessions: WorkspaceDeviceSessionRegistryPort;
    authorizationVerifier: WorkspaceCommandAuthorizationVerifierPort;
    workerAuthorizer: WorkspaceWorkerRuntimeAuthorizerPort;
    store: WorkspaceDispatchStorePort;
    now?: () => Date;
  }) {
    this.#sessions = config.sessions;
    this.#authorizationVerifier = config.authorizationVerifier;
    this.#workerAuthorizer = config.workerAuthorizer;
    this.#store = config.store;
    this.#now = config.now ?? (() => new Date());
    this.#sessions.setWorkspaceOrphanEventCommitter?.((event) =>
      this.#commitOrphanEvent(event),
    );
  }

  async execute(
    worker: WorkspaceWorkerIdentity,
    input: DeviceWorkspaceListCommand,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    this.#assertOpen();
    const command = parseDeviceWorkspaceListCommand(input);
    this.#workerAuthorizer.authorize(worker, command.runtimeBindingId);
    requireNotAborted(signal);
    const durable = await this.#matchingCommandRecord(command, signal);
    if (durable !== null) {
      return durable.resolution === null
        ? this.#resumePrepared(durable, signal)
        : structuredClone(durable.resolution);
    }
    await abortable(this.#authorizationVerifier.verify(command), signal);
    const target = this.#requireTarget(command);
    const prepared = await abortable(
      this.#store.prepare(command, this.#timestamp()),
      signal,
    );
    if (prepared.record.resolution !== null) {
      return structuredClone(prepared.record.resolution);
    }
    return prepared.outcome === "existing"
      ? this.#resumePrepared(prepared.record, signal)
      : this.#start(prepared.record, target);
  }

  async reconcile(
    worker: WorkspaceWorkerIdentity,
    input: DeviceWorkspaceListDispatchReference,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    return this.#resolveReference(worker, input, "reconcile", signal);
  }

  async cancel(
    worker: WorkspaceWorkerIdentity,
    input: DeviceWorkspaceListDispatchReference,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    return this.#resolveReference(worker, input, "cancel", signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#sessions.setWorkspaceOrphanEventCommitter?.(null);
    for (const active of this.#active.values()) {
      active.controller.abort("workspace_dispatch_shutdown");
    }
    await Promise.allSettled(
      [...this.#active.values()].map((active) => active.promise),
    );
    this.#active.clear();
  }

  async #resolveReference(
    worker: WorkspaceWorkerIdentity,
    input: DeviceWorkspaceListDispatchReference,
    operation: "reconcile" | "cancel",
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    this.#assertOpen();
    const reference = parseDeviceWorkspaceListDispatchReference(input);
    this.#workerAuthorizer.authorize(worker, reference.runtimeBindingId);
    requireNotAborted(signal);
    const durable = await abortable(
      this.#store.load(reference.executionId),
      signal,
    );
    if (durable === null) {
      return unknownResolution(reference.executionId, reference.receiptId);
    }
    requireReference(durable, reference);
    if (durable.resolution !== null) {
      return structuredClone(durable.resolution);
    }
    const promise = this.#resumePrepared(durable, signal);
    if (operation === "cancel") {
      const active = this.#active.get(reference.executionId);
      if (active !== undefined) {
        try {
          active.session.requestWorkspaceCancel(
            reference.executionId,
            "worker_cancel_requested",
          );
        } catch {
          // The durable accepted receipt still determines the outcome.
        }
      }
    }
    return promise;
  }

  async #resumePrepared(
    durable: WorkspaceDispatchAuthorityRecord,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    const active = this.#matchingActive(durable.command);
    if (active !== null) return active.promise;
    if (durable.acceptedEvent === null) {
      await abortable(
        this.#authorizationVerifier.verify(durable.command),
        signal,
      );
    }
    requireNotAborted(signal);
    const target = this.#requireTarget(durable.command);
    return this.#start(durable, target);
  }

  #start(
    durable: WorkspaceDispatchAuthorityRecord,
    target: WorkspaceDeviceSessionTarget,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    const command = durable.command;
    const prior = this.#matchingActive(command);
    if (prior !== null) return prior.promise;
    const eventRoute =
      durable.acceptedEvent === null
        ? target.route
        : requireDurableAcceptedRoute(durable);
    const controller = new AbortController();
    const active: ActiveWorkspaceDispatch = {
      fingerprint: durable.fingerprint,
      session: target.session,
      controller,
      promise: Promise.resolve(
        unknownResolution(
          durable.executionId,
          durable.acceptedEvent?.receiptId ?? null,
        ),
      ),
    };
    active.promise = target.session
      .executeWorkspaceList(
        command,
        target.route.connectionEpoch,
        durable.acceptedEvent === null
          ? { kind: "fresh" }
          : {
              kind: "durableReplay",
              acceptedConnectionEpoch: durable.acceptedEvent.connectionEpoch,
            },
        controller.signal,
        (event) => this.#commitEvent(command, eventRoute, event),
      )
      .catch(async (error: unknown) => {
        const persisted = await this.#matchingCommandRecord(
          command,
          controller.signal,
        );
        if (persisted !== null && persisted.resolution !== null) {
          return structuredClone(persisted.resolution);
        }
        throw error;
      })
      .finally(() => {
        if (this.#active.get(command.executionId) === active) {
          this.#active.delete(command.executionId);
        }
      });
    this.#active.set(command.executionId, active);
    return active.promise;
  }

  #commitEvent(
    command: DeviceWorkspaceListCommand,
    route: DeviceWorkspaceListPeerRoute,
    event: DeviceWorkspaceListEvent,
  ) {
    if (event.type === "workspace_list.accepted") {
      return this.#store.acceptEvent({ command, route, event });
    }
    const resolution = resolutionForTerminal(event);
    return this.#store.settleEvent({ command, route, event, resolution });
  }

  async #commitOrphanEvent(event: DeviceWorkspaceListEvent) {
    const durable = await this.#store.load(event.executionId);
    if (durable === null) {
      throw new DeviceGatewayError("device_execution_unknown");
    }
    const route =
      durable.route ??
      this.#sessions.workspaceSession(durable.command.deviceId)?.route ??
      null;
    if (route === null) {
      throw new DeviceGatewayError("workspace_dispatch_route_unavailable");
    }
    return this.#commitEvent(durable.command, route, event);
  }

  #requireTarget(
    command: DeviceWorkspaceListCommand,
  ): WorkspaceDeviceSessionTarget {
    const target = this.#sessions.workspaceSession(command.deviceId);
    if (target === null) {
      throw new DeviceGatewayError("device_unavailable");
    }
    if (!target.session.supportsWorkspaceList()) {
      throw new DeviceGatewayError("device_capability_unavailable");
    }
    return target;
  }

  #matchingActive(
    command: DeviceWorkspaceListCommand,
  ): ActiveWorkspaceDispatch | null {
    const active = this.#active.get(command.executionId);
    if (active === undefined) return null;
    if (active.fingerprint !== workspaceDispatchFingerprint(command)) {
      throw new DeviceGatewayError("workspace_dispatch_identity_conflict");
    }
    return active;
  }

  async #matchingCommandRecord(
    command: DeviceWorkspaceListCommand,
    signal: AbortSignal,
  ): Promise<WorkspaceDispatchAuthorityRecord | null> {
    const record = await abortable(
      this.#store.load(command.executionId),
      signal,
    );
    if (
      record !== null &&
      record.fingerprint !== workspaceDispatchFingerprint(command)
    ) {
      throw new DeviceGatewayError("workspace_dispatch_identity_conflict");
    }
    return record;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("workspace_dispatch_closed");
    }
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new DeviceGatewayError("workspace_dispatch_clock_invalid");
    }
    return value.toISOString();
  }
}

function requireDurableAcceptedRoute(
  durable: WorkspaceDispatchAuthorityRecord,
): DeviceWorkspaceListPeerRoute {
  if (durable.route === null || durable.acceptedEvent === null) {
    throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
  }
  return durable.route;
}

function requireReference(
  record: WorkspaceDispatchAuthorityRecord,
  reference: DeviceWorkspaceListDispatchReference,
): void {
  const command = record.command;
  const currentReceipt = record.acceptedEvent?.receiptId ?? null;
  if (
    command.deviceId !== reference.deviceId ||
    command.executionId !== reference.executionId ||
    command.workspaceBindingId !== reference.workspaceBindingId ||
    command.incarnationId !== reference.incarnationId ||
    command.deviceBindingId !== reference.deviceBindingId ||
    command.runtimeBindingId !== reference.runtimeBindingId ||
    command.actionDigest !== reference.actionDigest ||
    command.commandDigest !== reference.commandDigest ||
    (reference.receiptId !== null && currentReceipt !== reference.receiptId)
  ) {
    throw new DeviceGatewayError("workspace_dispatch_identity_conflict");
  }
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DeviceGatewayError("workspace_dispatch_not_sent");
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new DeviceGatewayError("workspace_dispatch_not_sent"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new DeviceGatewayError("workspace_dispatch_not_sent"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function resolutionForTerminal(
  event: Exclude<DeviceWorkspaceListEvent, { type: "workspace_list.accepted" }>,
): DeviceWorkspaceListDispatchResolution {
  switch (event.type) {
    case "workspace_list.completed":
      return {
        status: "completed",
        executionId: event.executionId,
        receiptId: event.receiptId,
        terminal: event,
      };
    case "workspace_list.failed":
      return {
        status: "failed",
        executionId: event.executionId,
        receiptId: event.receiptId,
        terminal: event,
      };
    case "workspace_list.canceled":
      return {
        status: "canceled",
        executionId: event.executionId,
        receiptId: event.receiptId,
        terminal: event,
      };
    case "workspace_list.unknown_outcome":
      return {
        status: "unknownOutcome",
        executionId: event.executionId,
        receiptId: event.receiptId,
        terminal: event,
      };
  }
}

function unknownResolution(
  executionId: string,
  receiptId: string | null,
): DeviceWorkspaceListDispatchResolution {
  return {
    status: "unknownOutcome",
    executionId,
    receiptId,
    terminal: null,
  };
}
