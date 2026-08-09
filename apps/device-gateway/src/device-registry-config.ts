import { DeviceGatewayError } from "./device-gateway-error.ts";

export type DeviceRegistration = Readonly<{
  deviceId: string;
  credentialId: string;
  fingerprint256: string;
}>;

export type DeviceRegistryConfig = Readonly<{
  schemaVersion: "crewon.device-registry.v0";
  devices: readonly DeviceRegistration[];
  workers: readonly WorkerRegistration[];
  gateways: readonly GatewayRegistration[];
  commandSigningKeys: readonly CommandSigningKeyRegistration[];
}>;

export type WorkerRegistration = Readonly<{
  workerId: string;
  credentialId: string;
  fingerprint256: string;
}>;

export type GatewayRegistration = Readonly<{
  gatewayId: string;
  credentialId: string;
  fingerprint256: string;
  endpoint: string;
}>;

export type CommandSigningKeyRegistration = Readonly<{
  keyId: string;
  publicKeyPem: string;
}>;

export function parseDeviceRegistryConfig(
  input: unknown,
): DeviceRegistryConfig {
  const root = requireObject(input, "device_registry_invalid");
  const hasGateways = Object.hasOwn(root, "gateways");
  const gatewayInputs = Array.isArray(root.gateways) ? root.gateways : null;
  requireExactKeys(root, [
    "commandSigningKeys",
    "devices",
    ...(hasGateways ? ["gateways"] : []),
    "schemaVersion",
    "workers",
  ]);
  if (
    root.schemaVersion !== "crewon.device-registry.v0" ||
    !Array.isArray(root.devices) ||
    !Array.isArray(root.workers) ||
    (hasGateways && gatewayInputs === null) ||
    !Array.isArray(root.commandSigningKeys) ||
    root.devices.length < 1 ||
    root.devices.length > 10_000 ||
    root.workers.length < 1 ||
    root.workers.length > 10_000 ||
    (gatewayInputs !== null &&
      (gatewayInputs.length < 1 || gatewayInputs.length > 1_000)) ||
    root.commandSigningKeys.length < 1 ||
    root.commandSigningKeys.length > 32
  ) {
    throw new DeviceGatewayError("device_registry_invalid");
  }
  const deviceIds = new Set<string>();
  const credentialIds = new Set<string>();
  const fingerprints = new Set<string>();
  const devices = root.devices.map((inputDevice) => {
    const device = requireObject(inputDevice, "device_registration_invalid");
    requireExactKeys(device, ["credentialId", "deviceId", "fingerprint256"]);
    requireOpaqueId(device.deviceId, "device_registration_invalid");
    requireOpaqueId(device.credentialId, "device_registration_invalid");
    if (
      typeof device.fingerprint256 !== "string" ||
      !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(device.fingerprint256) ||
      deviceIds.has(device.deviceId) ||
      credentialIds.has(device.credentialId) ||
      fingerprints.has(device.fingerprint256)
    ) {
      throw new DeviceGatewayError("device_registration_invalid");
    }
    deviceIds.add(device.deviceId);
    credentialIds.add(device.credentialId);
    fingerprints.add(device.fingerprint256);
    return {
      deviceId: device.deviceId,
      credentialId: device.credentialId,
      fingerprint256: device.fingerprint256,
    };
  });
  const workerIds = new Set<string>();
  const workers = root.workers.map((inputWorker) => {
    const worker = requireObject(inputWorker, "worker_registration_invalid");
    requireExactKeys(worker, ["credentialId", "fingerprint256", "workerId"]);
    requireOpaqueId(worker.workerId, "worker_registration_invalid");
    requireOpaqueId(worker.credentialId, "worker_registration_invalid");
    if (
      typeof worker.fingerprint256 !== "string" ||
      !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(worker.fingerprint256) ||
      workerIds.has(worker.workerId) ||
      credentialIds.has(worker.credentialId) ||
      fingerprints.has(worker.fingerprint256)
    ) {
      throw new DeviceGatewayError("worker_registration_invalid");
    }
    workerIds.add(worker.workerId);
    credentialIds.add(worker.credentialId);
    fingerprints.add(worker.fingerprint256);
    return {
      workerId: worker.workerId,
      credentialId: worker.credentialId,
      fingerprint256: worker.fingerprint256,
    };
  });
  const gatewayIds = new Set<string>();
  const gatewayEndpoints = new Set<string>();
  const gateways = (gatewayInputs ?? []).map((inputGateway: unknown) => {
    const gateway = requireObject(inputGateway, "gateway_registration_invalid");
    requireExactKeys(gateway, [
      "credentialId",
      "endpoint",
      "fingerprint256",
      "gatewayId",
    ]);
    requireOpaqueId(gateway.gatewayId, "gateway_registration_invalid");
    requireOpaqueId(gateway.credentialId, "gateway_registration_invalid");
    const endpoint = requireGatewayEndpoint(gateway.endpoint);
    if (
      typeof gateway.fingerprint256 !== "string" ||
      !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(gateway.fingerprint256) ||
      gatewayIds.has(gateway.gatewayId) ||
      gatewayEndpoints.has(endpoint) ||
      credentialIds.has(gateway.credentialId) ||
      fingerprints.has(gateway.fingerprint256)
    ) {
      throw new DeviceGatewayError("gateway_registration_invalid");
    }
    gatewayIds.add(gateway.gatewayId);
    gatewayEndpoints.add(endpoint);
    credentialIds.add(gateway.credentialId);
    fingerprints.add(gateway.fingerprint256);
    return {
      gatewayId: gateway.gatewayId,
      credentialId: gateway.credentialId,
      fingerprint256: gateway.fingerprint256,
      endpoint,
    };
  });
  const keyIds = new Set<string>();
  const commandSigningKeys = root.commandSigningKeys.map((inputKey) => {
    const key = requireObject(inputKey, "device_signing_key_invalid");
    requireExactKeys(key, ["keyId", "publicKeyPem"]);
    requireOpaqueId(key.keyId, "device_signing_key_invalid");
    if (
      typeof key.publicKeyPem !== "string" ||
      key.publicKeyPem.length < 1 ||
      new TextEncoder().encode(key.publicKeyPem).byteLength > 16 * 1024 ||
      key.publicKeyPem.includes("\0") ||
      keyIds.has(key.keyId)
    ) {
      throw new DeviceGatewayError("device_signing_key_invalid");
    }
    keyIds.add(key.keyId);
    return { keyId: key.keyId, publicKeyPem: key.publicKeyPem };
  });
  return {
    schemaVersion: "crewon.device-registry.v0",
    devices,
    workers,
    gateways,
    commandSigningKeys,
  };
}

function requireGatewayEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new DeviceGatewayError("gateway_registration_invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new DeviceGatewayError("gateway_registration_invalid", {
      cause: error,
    });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.hostname.length === 0
  ) {
    throw new DeviceGatewayError("gateway_registration_invalid");
  }
  return endpoint.origin;
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new DeviceGatewayError(code);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new DeviceGatewayError("device_registry_fields_invalid");
  }
}

function requireOpaqueId(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)
  ) {
    throw new DeviceGatewayError(code);
  }
}
