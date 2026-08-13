import { randomUUID } from "node:crypto";

import type { RunRoute } from "@crewon/application";
import {
  Ed25519DeviceCommandSigner,
  Ed25519DeviceWorkspaceListCommandSigner,
} from "@crewon/device-dispatch";

import type { RuntimeNativeWorkspaceBootstrap } from "./runtime-native-bootstrap.ts";
import {
  LocalWorkspaceListDispatchClient,
  LocalWorkspaceReadGatewayClient,
} from "./runtime-local-workspace.ts";
import type { RuntimeWorkerCompositionConfig } from "./standalone-composition.ts";

export type RuntimeNativeWorkspaceResources = Readonly<{
  config: NonNullable<RuntimeWorkerCompositionConfig["workspacePrivate"]>;
  readFile: NonNullable<RuntimeWorkerCompositionConfig["workspaceReadFile"]>;
  close(): Promise<void>;
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
      authorizationTtlMs: input.bootstrap.deadlineMs,
    });
    readSigner = new Ed25519DeviceCommandSigner({
      keyId: input.bootstrap.signing.keyId,
      privateKey: { key: signingKey, format: "pem" },
      authorizationTtlMs: input.bootstrap.deadlineMs,
    });
  } finally {
    signingKey.fill(0);
  }
  const listAuthority = new LocalWorkspaceListDispatchClient({
    root: input.bootstrap.trustedLocalPath,
    authority,
  });
  const readAuthority = new LocalWorkspaceReadGatewayClient({
    root: input.bootstrap.trustedLocalPath,
    authority,
  });
  return {
    async close(): Promise<void> {
      await Promise.allSettled([listAuthority.close(), readAuthority.close()]);
    },
    readFile: { signer: readSigner, gateway: readAuthority },
    config: {
      port: input.bootstrap.privateServer.port,
      token: input.bootstrap.privateServer.token,
      authority,
      ids: {
        nextExecutionId: () => `workspace-execution-${randomUUID()}`,
      },
      signer,
      gateway: listAuthority,
      deadlineMs: input.bootstrap.deadlineMs,
    },
  };
}
