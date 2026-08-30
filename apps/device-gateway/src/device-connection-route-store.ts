import { DeviceGatewayError } from "./device-gateway-error.ts";

export type DeviceConnectionRoute = Readonly<{
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  epoch: number;
  leaseExpiresAt: string;
  updatedAt: string;
}>;

export type ClaimDeviceConnectionInput = Readonly<{
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  leaseDurationMs: number;
}>;

export type FenceDeviceConnectionInput = Readonly<{
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  epoch: number;
}>;

/** Owns the single current Gateway connection epoch for each authenticated Device. */
export interface DeviceConnectionRouteStorePort {
  claimConnection(
    input: ClaimDeviceConnectionInput,
  ): Promise<DeviceConnectionRoute>;
  renewConnection(
    input: FenceDeviceConnectionInput & Readonly<{ leaseDurationMs: number }>,
  ): Promise<DeviceConnectionRoute | null>;
  releaseConnection(input: FenceDeviceConnectionInput): Promise<boolean>;
  loadConnection(deviceId: string): Promise<DeviceConnectionRoute | null>;
}

export class InMemoryDeviceConnectionRouteStore
  implements DeviceConnectionRouteStorePort
{
  readonly #now: () => Date;
  readonly #routes = new Map<string, DeviceConnectionRoute>();

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async claimConnection(
    rawInput: ClaimDeviceConnectionInput,
  ): Promise<DeviceConnectionRoute> {
    const input = validateClaimDeviceConnectionInput(rawInput);
    const now = this.#validNow();
    const prior = this.#routes.get(input.deviceId);
    const route = parseDeviceConnectionRoute({
      deviceId: input.deviceId,
      gatewayId: input.gatewayId,
      connectionId: input.connectionId,
      epoch: (prior?.epoch ?? 0) + 1,
      leaseExpiresAt: new Date(
        now.getTime() + input.leaseDurationMs,
      ).toISOString(),
      updatedAt: now.toISOString(),
    });
    this.#routes.set(route.deviceId, structuredClone(route));
    return structuredClone(route);
  }

  async renewConnection(
    rawInput: FenceDeviceConnectionInput &
      Readonly<{ leaseDurationMs: number }>,
  ): Promise<DeviceConnectionRoute | null> {
    const input = {
      ...validateFenceDeviceConnectionInput(rawInput),
      leaseDurationMs: requireLeaseDuration(rawInput.leaseDurationMs),
    };
    const now = this.#validNow();
    const prior = this.#routes.get(input.deviceId);
    if (
      prior === undefined ||
      !sameFence(prior, input) ||
      Date.parse(prior.leaseExpiresAt) <= now.getTime()
    ) {
      return null;
    }
    const renewed = parseDeviceConnectionRoute({
      ...prior,
      leaseExpiresAt: new Date(
        now.getTime() + input.leaseDurationMs,
      ).toISOString(),
      updatedAt: now.toISOString(),
    });
    this.#routes.set(renewed.deviceId, structuredClone(renewed));
    return structuredClone(renewed);
  }

  async releaseConnection(
    rawInput: FenceDeviceConnectionInput,
  ): Promise<boolean> {
    const input = validateFenceDeviceConnectionInput(rawInput);
    const prior = this.#routes.get(input.deviceId);
    if (prior === undefined || !sameFence(prior, input)) {
      return false;
    }
    const now = this.#validNow();
    this.#routes.set(input.deviceId, {
      ...prior,
      leaseExpiresAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    return true;
  }

  async loadConnection(
    deviceId: string,
  ): Promise<DeviceConnectionRoute | null> {
    const validated = validateDeviceId(deviceId);
    const route = this.#routes.get(validated);
    if (
      route === undefined ||
      Date.parse(route.leaseExpiresAt) <= this.#validNow().getTime()
    ) {
      return null;
    }
    return structuredClone(route);
  }

  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new DeviceGatewayError("device_connection_clock_invalid");
    }
    return now;
  }
}

export function parseDeviceConnectionRoute(
  input: unknown,
): DeviceConnectionRoute {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DeviceGatewayError("device_connection_route_invalid");
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [
    "connectionId",
    "deviceId",
    "epoch",
    "gatewayId",
    "leaseExpiresAt",
    "updatedAt",
  ].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new DeviceGatewayError("device_connection_route_invalid");
  }
  return {
    deviceId: requireOpaqueId(value.deviceId, "device_id_invalid"),
    gatewayId: requireOpaqueId(value.gatewayId, "device_gateway_id_invalid"),
    connectionId: requireOpaqueId(
      value.connectionId,
      "device_connection_id_invalid",
    ),
    epoch: requirePositiveSafeInteger(
      value.epoch,
      "device_connection_epoch_invalid",
    ),
    leaseExpiresAt: requireTimestamp(
      value.leaseExpiresAt,
      "device_connection_lease_invalid",
    ),
    updatedAt: requireTimestamp(
      value.updatedAt,
      "device_connection_updated_at_invalid",
    ),
  };
}

export function validateClaimDeviceConnectionInput(
  input: ClaimDeviceConnectionInput,
): ClaimDeviceConnectionInput {
  return {
    deviceId: requireOpaqueId(input.deviceId, "device_id_invalid"),
    gatewayId: requireOpaqueId(input.gatewayId, "device_gateway_id_invalid"),
    connectionId: requireOpaqueId(
      input.connectionId,
      "device_connection_id_invalid",
    ),
    leaseDurationMs: requireLeaseDuration(input.leaseDurationMs),
  };
}

export function validateFenceDeviceConnectionInput(
  input: FenceDeviceConnectionInput,
): FenceDeviceConnectionInput {
  return {
    deviceId: requireOpaqueId(input.deviceId, "device_id_invalid"),
    gatewayId: requireOpaqueId(input.gatewayId, "device_gateway_id_invalid"),
    connectionId: requireOpaqueId(
      input.connectionId,
      "device_connection_id_invalid",
    ),
    epoch: requirePositiveSafeInteger(
      input.epoch,
      "device_connection_epoch_invalid",
    ),
  };
}

export function requireLeaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new DeviceGatewayError("device_connection_lease_duration_invalid");
  }
  return value;
}

export function validateDeviceId(value: unknown): string {
  return requireOpaqueId(value, "device_id_invalid");
}

export function validateGatewayId(value: unknown): string {
  return requireOpaqueId(value, "device_gateway_id_invalid");
}

function sameFence(
  route: DeviceConnectionRoute,
  fence: FenceDeviceConnectionInput,
): boolean {
  return (
    route.deviceId === fence.deviceId &&
    route.gatewayId === fence.gatewayId &&
    route.connectionId === fence.connectionId &&
    route.epoch === fence.epoch
  );
}

function requireOpaqueId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
  ) {
    throw new DeviceGatewayError(code);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DeviceGatewayError(code);
  }
  return value as number;
}

function requireTimestamp(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new DeviceGatewayError(code);
  }
  return value;
}
