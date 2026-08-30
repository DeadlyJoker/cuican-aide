import {
  parseDeviceFilesystemReadCommand,
  parseDeviceFilesystemReadDispatchReference,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadDispatchOperation,
  type DeviceFilesystemReadDispatchReference,
  type DeviceFilesystemReadDispatchResolution,
  type DeviceFilesystemReadPeerRoute,
  type DeviceFilesystemReadPeerSourceWorker,
  type DeviceFilesystemReadRouteIntent,
} from "@crewon/contracts";

import {
  validateGatewayId,
  type DeviceConnectionRouteStorePort,
} from "./device-connection-route-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { DeviceGatewayWorkspaceReadService } from "./device-gateway-workspace-read-service.ts";
import type { WorkspaceWorkerIdentity } from "./worker-identity.ts";

type Input =
  | DeviceFilesystemReadCommand
  | DeviceFilesystemReadDispatchReference;
type Local = Pick<
  DeviceGatewayWorkspaceReadService,
  "execute" | "reconcile" | "cancel"
>;
export interface DeviceGatewayWorkspaceReadPeerDispatchPort {
  dispatchRead(
    route: DeviceFilesystemReadPeerRoute,
    operation: DeviceFilesystemReadDispatchOperation,
    input: Input,
    worker: DeviceFilesystemReadPeerSourceWorker,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
  close?(): void | Promise<void>;
}

/** Selects one local or peer Gateway without permitting recursive forwarding. */
export class DeviceGatewayWorkspaceReadRouter {
  readonly #gatewayId: string;
  readonly #config: {
    gatewayId: string;
    routes: DeviceConnectionRouteStorePort;
    local: Local;
    peers: DeviceGatewayWorkspaceReadPeerDispatchPort;
  };
  constructor(config: {
    gatewayId: string;
    routes: DeviceConnectionRouteStorePort;
    local: Local;
    peers: DeviceGatewayWorkspaceReadPeerDispatchPort;
  }) {
    this.#config = config;
    this.#gatewayId = validateGatewayId(config.gatewayId);
  }
  execute(
    worker: WorkspaceWorkerIdentity,
    intent: DeviceFilesystemReadRouteIntent,
    input: DeviceFilesystemReadCommand,
    signal = new AbortController().signal,
  ) {
    return this.#route(
      worker,
      intent,
      "execute",
      parseDeviceFilesystemReadCommand(input),
      signal,
    );
  }
  reconcile(
    worker: WorkspaceWorkerIdentity,
    intent: DeviceFilesystemReadRouteIntent,
    input: DeviceFilesystemReadDispatchReference,
    signal = new AbortController().signal,
  ) {
    return this.#route(
      worker,
      intent,
      "reconcile",
      parseDeviceFilesystemReadDispatchReference(input),
      signal,
    );
  }
  cancel(
    worker: WorkspaceWorkerIdentity,
    intent: DeviceFilesystemReadRouteIntent,
    input: DeviceFilesystemReadDispatchReference,
    signal = new AbortController().signal,
  ) {
    return this.#route(
      worker,
      intent,
      "cancel",
      parseDeviceFilesystemReadDispatchReference(input),
      signal,
    );
  }
  async #route(
    worker: WorkspaceWorkerIdentity,
    intent: DeviceFilesystemReadRouteIntent,
    operation: DeviceFilesystemReadDispatchOperation,
    input: Input,
    signal: AbortSignal,
  ) {
    try {
      return await dispatch(
        this.#config.local,
        worker,
        intent,
        operation,
        input,
        signal,
      );
    } catch (error) {
      if (
        !(error instanceof DeviceGatewayError) ||
        error.code !== "device_unavailable"
      )
        throw error;
    }
    if (signal.aborted) throw new DeviceGatewayError("workspace_read_not_sent");
    const current = await this.#config.routes.loadConnection(input.deviceId);
    if (signal.aborted) throw new DeviceGatewayError("workspace_read_not_sent");
    if (current === null || current.gatewayId === this.#gatewayId)
      throw new DeviceGatewayError("workspace_read_route_unavailable");
    const route: DeviceFilesystemReadPeerRoute = {
      deviceId: current.deviceId,
      gatewayId: current.gatewayId,
      connectionId: current.connectionId,
      connectionEpoch: current.epoch,
      deviceBindingId: intent.deviceBindingId,
      runtimeBindingId: intent.runtimeBindingId,
      capability: "workspace.read_file.v0",
      leaseExpiresAt: current.leaseExpiresAt,
    };
    return this.#config.peers.dispatchRead(
      route,
      operation,
      input,
      { workerId: worker.workerId, credentialId: worker.credentialId },
      signal,
    );
  }
}

function dispatch(
  local: Local,
  worker: WorkspaceWorkerIdentity,
  intent: DeviceFilesystemReadRouteIntent,
  operation: DeviceFilesystemReadDispatchOperation,
  input: Input,
  signal: AbortSignal,
) {
  if (operation === "execute")
    return local.execute(
      worker,
      intent,
      input as DeviceFilesystemReadCommand,
      signal,
    );
  return local[operation](
    worker,
    intent,
    input as DeviceFilesystemReadDispatchReference,
    signal,
  );
}
