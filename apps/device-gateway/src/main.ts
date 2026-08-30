import { readFile, stat } from "node:fs/promises";

import {
  createDeviceGatewayDispatchStoresFromEnvironment,
} from "./device-dispatch-store-config.ts";
import { DeviceGatewayServer } from "./device-gateway-server.ts";
import { resolveDeviceGatewayRuntimeIdentity } from "./device-gateway-runtime-config.ts";
import {
  deviceGatewayReadinessLine,
  resolveDeviceGatewayListenConfig,
} from "./device-gateway-main-config.ts";
import { HttpsDeviceGatewayPeerClient } from "./https-device-gateway-peer-client.ts";
import { HttpsDeviceGatewayWorkspacePeerClient } from "./https-device-gateway-workspace-peer-client.ts";
import { Ed25519DeviceCommandAuthorizationVerifier } from "./device-command-authorization-verifier.ts";
import { parseDeviceRegistryConfig } from "./device-registry-config.ts";
import { MtlsDeviceIdentityVerifier } from "./mtls-device-identity-verifier.ts";
import { MtlsGatewayIdentityVerifier } from "./mtls-gateway-identity-verifier.ts";
import { MtlsWorkerIdentityVerifier } from "./mtls-worker-identity-verifier.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";
import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";
import { Ed25519WorkspaceCommandAuthorizationVerifier } from "./workspace-command-authorization-verifier.ts";
import { WorkspaceWorkerRuntimeAuthorizer } from "./workspace-worker-runtime-authorizer.ts";

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
const {
  dispatchStore,
  workspaceDispatchStore,
  workspaceReadDispatchStore,
  connectionRouteStore,
} = createDeviceGatewayDispatchStoresFromEnvironment(process.env);
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
const runtimeIdentity = resolveDeviceGatewayRuntimeIdentity(
  process.env,
  dispatchStore instanceof PostgresDeviceDispatchStore
    ? "postgres"
    : dispatchStore instanceof SqliteDeviceDispatchStore
      ? "sqlite"
      : failUnsupportedDispatchAuthority(),
);
if (
  runtimeIdentity.kind === "team" &&
  !registry.gateways.some(
    (gateway) => gateway.gatewayId === runtimeIdentity.gatewayId,
  )
) {
  throw new Error("CREWON_DEVICE_GATEWAY_ID_unregistered");
}
const peerTls =
  runtimeIdentity.kind !== "team"
    ? null
    : {
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
      };
const peerDispatch =
  runtimeIdentity.kind !== "team" || peerTls === null
    ? null
    : new HttpsDeviceGatewayPeerClient({
        sourceGatewayId: runtimeIdentity.gatewayId,
        gateways: registry.gateways,
        tls: peerTls,
      });
const workspacePeerDispatch =
  runtimeIdentity.kind !== "team" || peerTls === null
    ? null
    : new HttpsDeviceGatewayWorkspacePeerClient({
        sourceGatewayId: runtimeIdentity.gatewayId,
        gateways: registry.gateways,
        tls: peerTls,
      });
const connectionRoutes =
  runtimeIdentity.kind === "team" ||
  runtimeIdentity.kind === "standaloneWorkspace"
    ? {
        store: connectionRouteStore,
        gatewayId: runtimeIdentity.gatewayId,
        leaseDurationMs: parseOptionalPositiveInteger(
          process.env.CREWON_DEVICE_CONNECTION_LEASE_MS,
          30_000,
          "CREWON_DEVICE_CONNECTION_LEASE_MS_invalid",
        ),
      }
    : undefined;
const server = new DeviceGatewayServer({
  tls: serverTls,
  identityVerifier: new MtlsDeviceIdentityVerifier(registry.devices),
  workerIdentityVerifier: new MtlsWorkerIdentityVerifier(registry.workers),
  authorizationVerifier: new Ed25519DeviceCommandAuthorizationVerifier(
    registry.commandSigningKeys,
  ),
  dispatchStore,
  workspaceDispatchStore,
  workspaceReadDispatchStore,
  workspaceAuthorizationVerifier:
    new Ed25519WorkspaceCommandAuthorizationVerifier(
      registry.commandSigningKeys,
    ),
  workspaceWorkerAuthorizer: new WorkspaceWorkerRuntimeAuthorizer(
    registry.workers,
  ),
  connectionRoutes,
  workspaceRouteTopology:
    runtimeIdentity.kind === "standaloneToolOnly"
      ? undefined
      : runtimeIdentity.kind === "team"
        ? "team"
        : "standalone",
  gatewayIdentityVerifier:
    runtimeIdentity.kind !== "team"
      ? undefined
      : new MtlsGatewayIdentityVerifier(registry.gateways),
  peerDispatch: peerDispatch ?? undefined,
  workspacePeerDispatch: workspacePeerDispatch ?? undefined,
  workspaceReadPeerDispatch: workspacePeerDispatch ?? undefined,
});
const listen = resolveDeviceGatewayListenConfig(process.env, runtimeIdentity);
const address = await server.listen(listen.host, listen.port);
process.stdout.write(
  `${deviceGatewayReadinessLine(address, runtimeIdentity)}\n`,
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

function failUnsupportedDispatchAuthority(): never {
  throw new Error("device_gateway_dispatch_authority_unsupported");
}
