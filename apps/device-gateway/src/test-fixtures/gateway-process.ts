import { X509Certificate } from "node:crypto";

import { PostgresDeviceDispatchStore } from "../postgres-device-dispatch-store.ts";
import { PostgresWorkspaceDispatchStore } from "../postgres-workspace-dispatch-store.ts";
import { DeviceGatewayServer } from "../device-gateway-server.ts";
import { HttpsDeviceGatewayPeerClient } from "../https-device-gateway-peer-client.ts";
import { HttpsDeviceGatewayWorkspacePeerClient } from "../https-device-gateway-workspace-peer-client.ts";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_WORKER_CERT,
  TEST_WORKER_KEY,
} from "../mtls-test-certificates.test-support.ts";
import { MtlsGatewayIdentityVerifier } from "../mtls-gateway-identity-verifier.ts";
import { WorkspaceWorkerRuntimeAuthorizer } from "../workspace-worker-runtime-authorizer.ts";

const gatewayId = requiredEnvironment("CREWON_TEST_GATEWAY_ID");
const connectionString = requiredEnvironment("CREWON_TEST_POSTGRES_URL");
const schema = requiredEnvironment("CREWON_TEST_POSTGRES_SCHEMA");
const peerGatewayId = process.env.CREWON_TEST_PEER_GATEWAY_ID;
const peerEndpoint = process.env.CREWON_TEST_PEER_ENDPOINT;
const inboundGatewayId = process.env.CREWON_TEST_INBOUND_GATEWAY_ID;
const workspaceEnabled = process.env.CREWON_TEST_WORKSPACE_ENABLED === "1";
if ((peerGatewayId === undefined) !== (peerEndpoint === undefined)) {
  throw new Error("test_gateway_peer_config_invalid");
}

const store = new PostgresDeviceDispatchStore({ connectionString, schema });
const workspaceStore = workspaceEnabled
  ? new PostgresWorkspaceDispatchStore({ connectionString, schema })
  : undefined;
const peerDispatch =
  peerGatewayId === undefined || peerEndpoint === undefined
    ? undefined
    : new HttpsDeviceGatewayPeerClient({
        sourceGatewayId: gatewayId,
        gateways: [
          {
            gatewayId: peerGatewayId,
            credentialId: `${peerGatewayId}-credential`,
            fingerprint256: new X509Certificate(TEST_SERVER_CERT)
              .fingerprint256,
            endpoint: peerEndpoint,
          },
        ],
        tls: {
          key: TEST_WORKER_KEY,
          cert: TEST_WORKER_CERT,
          ca: TEST_CA_CERT,
          servername: "localhost",
        },
      });
const workspacePeerDispatch = !workspaceEnabled
  ? undefined
  : peerGatewayId === undefined || peerEndpoint === undefined
    ? {
        async dispatch() {
          throw new Error("workspace_test_peer_unavailable");
        },
      }
    : new HttpsDeviceGatewayWorkspacePeerClient({
        sourceGatewayId: gatewayId,
        gateways: [
          {
            gatewayId: peerGatewayId,
            credentialId: `${peerGatewayId}-credential`,
            fingerprint256: new X509Certificate(TEST_SERVER_CERT)
              .fingerprint256,
            endpoint: peerEndpoint,
          },
        ],
        tls: {
          key: TEST_WORKER_KEY,
          cert: TEST_WORKER_CERT,
          ca: TEST_CA_CERT,
          servername: "localhost",
        },
      });
const gatewayIdentityVerifier =
  inboundGatewayId === undefined
    ? workspaceEnabled
      ? {
          verify: async () =>
            Promise.reject(new Error("peer ingress unavailable")),
        }
      : undefined
    : new MtlsGatewayIdentityVerifier([
        {
          gatewayId: inboundGatewayId,
          credentialId: `${inboundGatewayId}-credential`,
          fingerprint256: new X509Certificate(TEST_WORKER_CERT).fingerprint256,
          endpoint: `https://${inboundGatewayId}.invalid`,
        },
      ]);
const server = new DeviceGatewayServer({
  tls: {
    key: TEST_SERVER_KEY,
    cert: TEST_SERVER_CERT,
    ca: TEST_CA_CERT,
  },
  identityVerifier: {
    async verify() {
      return {
        deviceId: "device-1",
        credentialId: "device-credential-1",
        authenticationMethod: "mtls" as const,
        authenticatedAt: new Date().toISOString(),
      };
    },
  },
  workerIdentityVerifier: {
    async verify() {
      return {
        workerId: "worker-1",
        credentialId: "worker-credential-1",
        authenticationMethod: "mtls" as const,
        authenticatedAt: new Date().toISOString(),
      };
    },
  },
  gatewayIdentityVerifier,
  authorizationVerifier: { verify: async () => undefined },
  dispatchStore: store,
  workspaceDispatchStore: workspaceStore,
  workspaceAuthorizationVerifier: workspaceEnabled
    ? { verify: async () => undefined }
    : undefined,
  workspaceWorkerAuthorizer: workspaceEnabled
    ? new WorkspaceWorkerRuntimeAuthorizer([
        {
          workerId: "worker-1",
          credentialId: "worker-credential-1",
          fingerprint256: new X509Certificate(TEST_WORKER_CERT).fingerprint256,
          allowedRuntimeBindingIds: ["runtime-binding-1"],
        },
      ])
    : undefined,
  connectionRoutes: {
    store,
    gatewayId,
    leaseDurationMs: 30_000,
  },
  peerDispatch,
  workspacePeerDispatch,
});

const address = await server.listen("127.0.0.1", 0);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: "crewon.test-gateway-ready.v0",
    gatewayId,
    port: address.port,
  })}\n`,
);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) {
      return;
    }
    closing = true;
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}
