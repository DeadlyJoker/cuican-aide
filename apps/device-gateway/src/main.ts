import { readFile, stat } from "node:fs/promises";

import { createDeviceDispatchStoreFromEnvironment } from "./device-dispatch-store-config.ts";
import { DeviceGatewayServer } from "./device-gateway-server.ts";
import { HttpsDeviceGatewayPeerClient } from "./https-device-gateway-peer-client.ts";
import { Ed25519DeviceCommandAuthorizationVerifier } from "./device-command-authorization-verifier.ts";
import { parseDeviceRegistryConfig } from "./device-registry-config.ts";
import { MtlsDeviceIdentityVerifier } from "./mtls-device-identity-verifier.ts";
import { MtlsGatewayIdentityVerifier } from "./mtls-gateway-identity-verifier.ts";
import { MtlsWorkerIdentityVerifier } from "./mtls-worker-identity-verifier.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";

const registry = parseDeviceRegistryConfig(
  JSON.parse(
    (
      await readBoundedFile(
        requiredEnvironment("CREWON_DEVICE_REGISTRY_PATH"),
        2 * 1024 * 1024,
        "device_registry_file_invalid",
      )
    ).toString("utf8"),
  ),
);
const dispatchStore = createDeviceDispatchStoreFromEnvironment(process.env);
const serverTls = {
  key: await readBoundedFile(
    requiredEnvironment("CREWON_DEVICE_GATEWAY_TLS_KEY_PATH"),
    1024 * 1024,
    "device_gateway_tls_key_invalid",
  ),
  cert: await readBoundedFile(
    requiredEnvironment("CREWON_DEVICE_GATEWAY_TLS_CERT_PATH"),
    4 * 1024 * 1024,
    "device_gateway_tls_certificate_invalid",
  ),
  ca: await readBoundedFile(
    requiredEnvironment("CREWON_DEVICE_GATEWAY_TLS_CA_PATH"),
    4 * 1024 * 1024,
    "device_gateway_tls_ca_invalid",
  ),
};
const gatewayId =
  dispatchStore instanceof PostgresDeviceDispatchStore
    ? requiredEnvironment("CREWON_DEVICE_GATEWAY_ID")
    : null;
if (
  gatewayId !== null &&
  !registry.gateways.some((gateway) => gateway.gatewayId === gatewayId)
) {
  throw new Error("CREWON_DEVICE_GATEWAY_ID_unregistered");
}
const peerDispatch =
  gatewayId === null
    ? null
    : new HttpsDeviceGatewayPeerClient({
        sourceGatewayId: gatewayId,
        gateways: registry.gateways,
        tls: {
          key: await readBoundedFile(
            requiredEnvironment("CREWON_DEVICE_GATEWAY_PEER_TLS_KEY_PATH"),
            1024 * 1024,
            "device_gateway_peer_tls_key_invalid",
          ),
          cert: await readBoundedFile(
            requiredEnvironment("CREWON_DEVICE_GATEWAY_PEER_TLS_CERT_PATH"),
            4 * 1024 * 1024,
            "device_gateway_peer_tls_certificate_invalid",
          ),
          ca: serverTls.ca,
        },
      });
const server = new DeviceGatewayServer({
  tls: serverTls,
  identityVerifier: new MtlsDeviceIdentityVerifier(registry.devices),
  workerIdentityVerifier: new MtlsWorkerIdentityVerifier(registry.workers),
  authorizationVerifier: new Ed25519DeviceCommandAuthorizationVerifier(
    registry.commandSigningKeys,
  ),
  dispatchStore,
  connectionRoutes:
    gatewayId !== null && dispatchStore instanceof PostgresDeviceDispatchStore
      ? {
          store: dispatchStore,
          gatewayId,
          leaseDurationMs: parseOptionalPositiveInteger(
            process.env.CREWON_DEVICE_CONNECTION_LEASE_MS,
            30_000,
            "CREWON_DEVICE_CONNECTION_LEASE_MS_invalid",
          ),
        }
      : undefined,
  gatewayIdentityVerifier:
    gatewayId === null
      ? undefined
      : new MtlsGatewayIdentityVerifier(registry.gateways),
  peerDispatch: peerDispatch ?? undefined,
});
const address = await server.listen(
  environmentOr("CREWON_DEVICE_GATEWAY_HOST", "127.0.0.1"),
  parsePort(environmentOr("CREWON_DEVICE_GATEWAY_PORT", "8443")),
);
process.stdout.write(
  `CrewON Device Gateway listening on wss://${displayHost(address.host)}:${address.port}${address.path}\n`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  code: string,
): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes) {
    throw new Error(code);
  }
  const contents = await readFile(path);
  if (contents.byteLength < 1 || contents.byteLength > maxBytes) {
    throw new Error(code);
  }
  return contents;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function environmentOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) {
    throw new Error("CREWON_DEVICE_GATEWAY_PORT_invalid");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CREWON_DEVICE_GATEWAY_PORT_invalid");
  }
  return port;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  fallback: number,
  code: string,
): number {
  const selected = value?.trim() || String(fallback);
  if (!/^\d+$/.test(selected)) {
    throw new Error(code);
  }
  const parsed = Number(selected);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 300_000) {
    throw new Error(code);
  }
  return parsed;
}

function displayHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
