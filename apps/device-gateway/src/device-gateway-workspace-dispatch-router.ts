import {
  parseDeviceWorkspaceListCommand,
  parseDeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchOperation,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceWorkspaceListPeerRoute,
  type DeviceWorkspaceListPeerSourceWorker,
} from "@crewon/contracts";

import {
  validateGatewayId,
  type DeviceConnectionRoute,
  type DeviceConnectionRouteStorePort,
} from "./device-connection-route-store.ts";
import type { DeviceGatewayWorkspaceDispatchService } from "./device-gateway-workspace-dispatch-service.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { WorkspaceWorkerIdentity } from "./worker-identity.ts";

type WorkspaceDispatchInput =
  | DeviceWorkspaceListCommand
  | DeviceWorkspaceListDispatchReference;

type WorkspaceDispatchPort = Pick<
  DeviceGatewayWorkspaceDispatchService,
  "execute" | "reconcile" | "cancel"
>;

export interface DeviceGatewayWorkspacePeerDispatchPort {
  dispatch(
    route: DeviceWorkspaceListPeerRoute,
    operation: DeviceWorkspaceListDispatchOperation,
    input: WorkspaceDispatchInput,
    sourceWorker: DeviceWorkspaceListPeerSourceWorker,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution>;
  close?(): void | Promise<void>;
}

/** Routes Workspace operations without weakening the local receipt-first authority. */
export class DeviceGatewayWorkspaceDispatchRouter
  implements WorkspaceDispatchPort
{
  readonly #gatewayId: string;
  readonly #routes: DeviceConnectionRouteStorePort;
  readonly #local: WorkspaceDispatchPort;
  readonly #peers: DeviceGatewayWorkspacePeerDispatchPort;

  constructor(config: {
    gatewayId: string;
    routes: DeviceConnectionRouteStorePort;
    local: WorkspaceDispatchPort;
    peers: DeviceGatewayWorkspacePeerDispatchPort;
  }) {
    this.#gatewayId = validateGatewayId(config.gatewayId);
    this.#routes = config.routes;
    this.#local = config.local;
    this.#peers = config.peers;
  }

  execute(
    worker: WorkspaceWorkerIdentity,
    input: DeviceWorkspaceListCommand,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    return this.#route(
      worker,
      "execute",
      parseDeviceWorkspaceListCommand(input),
      signal,
    );
  }

  reconcile(
    worker: WorkspaceWorkerIdentity,
    input: DeviceWorkspaceListDispatchReference,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    return this.#route(
      worker,
      "reconcile",
      parseDeviceWorkspaceListDispatchReference(input),
      signal,
    );
  }

  cancel(
    worker: WorkspaceWorkerIdentity,
    input: DeviceWorkspaceListDispatchReference,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    return this.#route(
      worker,
      "cancel",
      parseDeviceWorkspaceListDispatchReference(input),
      signal,
    );
  }

  async #route(
    worker: WorkspaceWorkerIdentity,
    operation: DeviceWorkspaceListDispatchOperation,
    input: WorkspaceDispatchInput,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    try {
      return await dispatchOperation(
        this.#local,
        worker,
        operation,
        input,
        signal,
      );
    } catch (error) {
      if (!isRemoteOwnerCandidate(error)) throw error;
    }
    requireNotAborted(signal);
    const route = await abortable(
      this.#routes.loadConnection(input.deviceId),
      signal,
    );
    if (route === null || route.gatewayId === this.#gatewayId) {
      throw new DeviceGatewayError("workspace_dispatch_route_unavailable");
    }
    return this.#peers.dispatch(
      workspacePeerRoute(route),
      operation,
      input,
      {
        workerId: worker.workerId,
        credentialId: worker.credentialId,
      },
      signal,
    );
  }
}

function dispatchOperation(
  dispatch: WorkspaceDispatchPort,
  worker: WorkspaceWorkerIdentity,
  operation: DeviceWorkspaceListDispatchOperation,
  input: WorkspaceDispatchInput,
  signal: AbortSignal,
): Promise<DeviceWorkspaceListDispatchResolution> {
  switch (operation) {
    case "execute":
      return dispatch.execute(
        worker,
        input as DeviceWorkspaceListCommand,
        signal,
      );
    case "reconcile":
      return dispatch.reconcile(
        worker,
        input as DeviceWorkspaceListDispatchReference,
        signal,
      );
    case "cancel":
      return dispatch.cancel(
        worker,
        input as DeviceWorkspaceListDispatchReference,
        signal,
      );
  }
}

export function workspacePeerRoute(
  route: DeviceConnectionRoute,
): DeviceWorkspaceListPeerRoute {
  return {
    deviceId: route.deviceId,
    gatewayId: route.gatewayId,
    connectionId: route.connectionId,
    connectionEpoch: route.epoch,
    leaseExpiresAt: route.leaseExpiresAt,
  };
}

export function sameWorkspacePeerRoute(
  left: DeviceWorkspaceListPeerRoute,
  right: DeviceWorkspaceListPeerRoute,
): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.gatewayId === right.gatewayId &&
    left.connectionId === right.connectionId &&
    left.connectionEpoch === right.connectionEpoch &&
    left.leaseExpiresAt === right.leaseExpiresAt
  );
}

function isRemoteOwnerCandidate(error: unknown): boolean {
  return (
    error instanceof DeviceGatewayError && error.code === "device_unavailable"
  );
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
