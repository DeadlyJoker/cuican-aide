import { randomUUID } from "node:crypto";

import type { RunRoute } from "@crewon/application";
import {
  Ed25519DeviceCommandSigner,
  Ed25519DeviceWorkspaceListCommandSigner,
  HttpsDeviceWorkspaceListDispatchClient,
} from "@crewon/device-dispatch";

import type { RuntimeNativeWorkspaceBootstrap } from "./runtime-native-bootstrap.ts";
import { HttpsRuntimeWorkspaceReadGatewayClient } from "./runtime-workspace-read-gateway-client.ts";
import type { RuntimeWorkerCompositionConfig } from "./standalone-composition.ts";

export type RuntimeNativeWorkspaceResources = Readonly<{
  config: NonNullable<RuntimeWorkerCompositionConfig["workspacePrivate"]>;
  gateway: HttpsDeviceWorkspaceListDispatchClient;
  readFile: NonNullable<RuntimeWorkerCompositionConfig["workspaceReadFile"]>;
  readGateway: HttpsRuntimeWorkspaceReadGatewayClient;
}>;

/** Constructs the packaged Workspace resources without ambient routes or secrets. */
export function createRuntimeNativeWorkspaceResources(input: {
  bootstrap: RuntimeNativeWorkspaceBootstrap;
  runtimeTenantId: string;
  route: RunRoute;
}): RuntimeNativeWorkspaceResources {
  const { authority } = input.bootstrap;
  if (
    authority.tenantId !== input.runtimeTenantId ||
    authority.workspaceBindingId !== input.route.workspaceBindingId ||
    authority.runtimeBindingId !== input.route.runtimeGeneration ||
    authority.policySnapshotId !== input.route.policySnapshotId
  ) {
    throw new Error("runtime_workspace_deployment_mismatch");
  }
  const signingKey = Buffer.from(input.bootstrap.signing.privateKeyPem, "utf8");
  let signer: Ed25519DeviceWorkspaceListCommandSigner;
  let readSigner: Ed25519DeviceCommandSigner;
  try {
    signer = new Ed25519DeviceWorkspaceListCommandSigner({
      keyId: input.bootstrap.signing.keyId,
      privateKey: { key: signingKey, format: "pem" },
      authorizationTtlMs: input.bootstrap.gateway.deadlineMs,
    });
    readSigner = new Ed25519DeviceCommandSigner({
      keyId: input.bootstrap.signing.keyId,
      privateKey: { key: signingKey, format: "pem" },
      authorizationTtlMs: input.bootstrap.gateway.deadlineMs,
    });
  } finally {
    signingKey.fill(0);
  }
  const gateway = new HttpsDeviceWorkspaceListDispatchClient({
    endpoint: input.bootstrap.gateway.endpoint,
    tls: {
      key: input.bootstrap.gateway.tls.keyPem,
      cert: input.bootstrap.gateway.tls.certificatePem,
      ca: input.bootstrap.gateway.tls.caCertificatePem,
      servername: input.bootstrap.gateway.tls.servername,
    },
    requestTimeoutMs: input.bootstrap.gateway.deadlineMs,
  });
  const readGateway = new HttpsRuntimeWorkspaceReadGatewayClient({
    endpoint: input.bootstrap.gateway.endpoint,
    tls: {
      key: input.bootstrap.gateway.tls.keyPem,
      cert: input.bootstrap.gateway.tls.certificatePem,
      ca: input.bootstrap.gateway.tls.caCertificatePem,
      servername: input.bootstrap.gateway.tls.servername,
    },
    requestTimeoutMs: input.bootstrap.gateway.deadlineMs,
  });
  return {
    gateway,
    readGateway,
    readFile: { signer: readSigner, gateway: readGateway },
    config: {
      port: input.bootstrap.privateServer.port,
      token: input.bootstrap.privateServer.token,
      authority,
      ids: {
        nextExecutionId: () => `workspace-execution-${randomUUID()}`,
      },
      signer,
      gateway,
      deadlineMs: input.bootstrap.gateway.deadlineMs,
    },
  };
}
