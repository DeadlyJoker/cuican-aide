import {
  parseDeviceExecutionCommand,
  type DeviceDispatchOperation,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import {
  validateGatewayId,
  type DeviceConnectionRoute,
  type DeviceConnectionRouteStorePort,
} from "./device-connection-route-store.ts";
import type { DeviceGatewayDispatchService } from "./device-gateway-dispatch-service.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

type DispatchPort = Pick<
  DeviceGatewayDispatchService,
  "execute" | "reconcile" | "cancel"
>;

type SessionRegistryPort = Readonly<{
  session(deviceId: string): Readonly<{
    hello: Readonly<{ connectionId: string }>;
  }> | null;
}>;

export interface DeviceGatewayPeerDispatchPort {
  dispatch(
    route: DeviceConnectionRoute,
    operation: DeviceDispatchOperation,
    command: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution>;
  close?(): void | Promise<void>;
}

/** Routes Worker operations to the Gateway holding the fenced Device connection. */
export class DeviceGatewayDispatchRouter implements DispatchPort {
  readonly #gatewayId: string;
  readonly #routes: DeviceConnectionRouteStorePort;
  readonly #sessions: SessionRegistryPort;
  readonly #local: DispatchPort;
  readonly #peers: DeviceGatewayPeerDispatchPort;

  constructor(config: {
    gatewayId: string;
    routes: DeviceConnectionRouteStorePort;
    sessions: SessionRegistryPort;
    local: DispatchPort;
    peers: DeviceGatewayPeerDispatchPort;
  }) {
    this.#gatewayId = validateGatewayId(config.gatewayId);
    this.#routes = config.routes;
    this.#sessions = config.sessions;
    this.#local = config.local;
    this.#peers = config.peers;
  }

  execute(
    input: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    return this.#route("execute", input);
  }

  reconcile(
    input: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    return this.#route("reconcile", input);
  }

  cancel(
    input: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    return this.#route("cancel", input);
  }

  async dispatchExpected(
    expectedRoute: DeviceConnectionRoute,
    operation: DeviceDispatchOperation,
    input: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    const command = parseDeviceExecutionCommand(input);
    const current = await this.#routes.loadConnection(command.deviceId);
    if (
      current === null ||
      current.gatewayId !== this.#gatewayId ||
      !sameRouteFence(current, expectedRoute) ||
      this.#sessions.session(command.deviceId)?.hello.connectionId !==
        current.connectionId
    ) {
      throw new DeviceGatewayError("device_connection_route_stale");
    }
    return dispatchOperation(this.#local, operation, command);
  }

  async #route(
    operation: DeviceDispatchOperation,
    input: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    const command = parseDeviceExecutionCommand(input);
    const route = await this.#routes.loadConnection(command.deviceId);
    if (route === null) {
      return dispatchOperation(this.#local, operation, command);
    }
    return route.gatewayId === this.#gatewayId
      ? this.dispatchExpected(route, operation, command)
      : this.#peers.dispatch(route, operation, command);
  }
}

function dispatchOperation(
  dispatch: DispatchPort,
  operation: DeviceDispatchOperation,
  command: DeviceExecutionCommand,
): Promise<DeviceGatewayDispatchResolution> {
  switch (operation) {
    case "execute":
      return dispatch.execute(command);
    case "reconcile":
      return dispatch.reconcile(command);
    case "cancel":
      return dispatch.cancel(command);
  }
}

function sameRouteFence(
  left: DeviceConnectionRoute,
  right: DeviceConnectionRoute,
): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.gatewayId === right.gatewayId &&
    left.connectionId === right.connectionId &&
    left.epoch === right.epoch
  );
}
