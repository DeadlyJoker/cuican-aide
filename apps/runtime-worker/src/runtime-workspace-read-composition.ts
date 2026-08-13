import {
  WorkspaceReadFileApplicationService,
  type ContentDigester,
  type WorkspaceReadFileAuthorityPort,
  type WorkspaceReadFileStore,
} from "@crewon/application";
import {
  CompositeToolRuntime,
  InMemoryToolBroker,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import type { RuntimeWorkspaceDispatchAuthority } from "./runtime-workspace-binding-resolver.ts";
import { StoreBackedRuntimeWorkspaceAuthority } from "./runtime-workspace-binding-resolver.ts";
import {
  RuntimeWorkspaceReadApplicationAdapter,
  type RuntimeWorkspaceReadAuthorityStorePort,
} from "./runtime-workspace-read-application-adapter.ts";
import { RuntimeWorkspaceReadFileCommandService } from "./runtime-workspace-read-file-command-service.ts";
import { WorkspaceReadToolRuntime } from "./runtime-workspace-read-tool-runtime.ts";

export type NativeWorkspaceReadCatalog = "disabled" | "enabled";

export type RuntimeWorkspaceReadFileConfig = Readonly<{
  workspace: WorkspaceReadFileAuthorityPort &
    Readonly<{ close(): Promise<void> }>;
}>;

export type RuntimeWorkspaceReadCompositionStorePort = ConstructorParameters<
  typeof StoreBackedRuntimeWorkspaceAuthority
>[0]["store"] &
  RuntimeWorkspaceReadAuthorityStorePort;

/** Validates that immutable release metadata and private execution authority agree. */
export function validateRuntimeWorkspaceReadComposition(input: {
  catalog: NativeWorkspaceReadCatalog | undefined;
  readFile: RuntimeWorkspaceReadFileConfig | undefined;
  deployment: RuntimeWorkspaceDispatchAuthority | undefined;
}): void {
  const readEnabled = input.catalog === "enabled";
  if (
    readEnabled !== (input.readFile !== undefined) ||
    (input.readFile !== undefined && input.deployment === undefined)
  ) {
    throw new Error("runtime_workspace_read_configuration_incomplete");
  }
}

/** Composes the strict read_file Tool with durable Run, Thread, and receipt authority. */
export function createRuntimeWorkspaceReadToolRuntime(input: {
  store: RuntimeWorkspaceReadCompositionStorePort;
  workspaceReadStore: WorkspaceReadFileStore | undefined;
  readFile: RuntimeWorkspaceReadFileConfig | undefined;
  deployment: RuntimeWorkspaceDispatchAuthority | undefined;
  digester: ContentDigester;
  configuredRuntime: ToolRuntimePort | undefined;
}): ToolRuntimePort {
  if (input.readFile === undefined) {
    return input.configuredRuntime ?? new InMemoryToolBroker();
  }
  if (
    input.deployment === undefined ||
    input.workspaceReadStore === undefined
  ) {
    throw new Error("runtime_workspace_read_configuration_incomplete");
  }
  const bindings = new StoreBackedRuntimeWorkspaceAuthority({
    store: input.store,
    authority: input.deployment,
  });
  const application = new WorkspaceReadFileApplicationService({
    store: input.workspaceReadStore,
    commands: new RuntimeWorkspaceReadFileCommandService({
      bindings,
      digester: input.digester,
    }),
    authority: input.readFile.workspace,
  });
  const runtime = new WorkspaceReadToolRuntime({
    binding: {
      workspaceBindingId: input.deployment.workspaceBindingId,
      policySnapshotId: input.deployment.policySnapshotId,
    },
    port: new RuntimeWorkspaceReadApplicationAdapter({
      application,
      store: input.store,
      deployment: input.deployment,
      digester: input.digester,
    }),
  });
  return input.configuredRuntime === undefined
    ? runtime
    : new CompositeToolRuntime([input.configuredRuntime, runtime]);
}
