import { randomUUID } from "node:crypto";

import type { RunRoute } from "@crewon/application";

import type { RuntimeNativeWorkspaceBootstrap } from "./runtime-native-bootstrap.ts";
import {
  LocalWorkspaceListDispatchClient,
  LocalWorkspaceReadAuthority,
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
  const listAuthority = new LocalWorkspaceListDispatchClient({
    root: input.bootstrap.trustedLocalPath,
    authority,
  });
  const readAuthority = new LocalWorkspaceReadAuthority({
    root: input.bootstrap.trustedLocalPath,
    authority,
  });
  return {
    async close(): Promise<void> {
      await Promise.allSettled([listAuthority.close(), readAuthority.close()]);
    },
    readFile: { workspace: readAuthority },
    config: {
      port: input.bootstrap.privateServer.port,
      token: input.bootstrap.privateServer.token,
      authority,
      ids: {
        nextExecutionId: () => `workspace-execution-${randomUUID()}`,
      },
      workspace: listAuthority,
      nativeRoot: input.bootstrap.trustedLocalPath,
      deadlineMs: input.bootstrap.deadlineMs,
    },
  };
}
