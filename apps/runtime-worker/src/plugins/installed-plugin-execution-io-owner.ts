import { extensionCanonicalJson } from "@crewon/domain";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { ProjectMediaExecutionBoundary } from "../project-media-execution-boundary.ts";
import { captureNetworkApproval } from "./plugin-execution-io-network.ts";
import { PluginExecutionIoOwner } from "./plugin-execution-io.ts";
import type { InstalledPluginExecutionIoDependencies } from "./installed-plugin-execution-io-config.ts";
import { fail } from "./installed-plugin-runtime-resolver-package.ts";

/** Original network/identity checks, shared by ordinary and admitted media execution owners. */
export async function createInstalledPluginExecutionIoOwner(
  input: Readonly<{
    context: PluginToolRuntimeContext;
    approvalRequirement: "none" | "perAction";
    config: InstalledPluginExecutionIoDependencies | undefined;
    media: ProjectMediaExecutionBoundary | null;
    purpose: "submit" | "observe";
    signal: AbortSignal;
    authorize(
      purpose: "submit" | "observe",
      signal: AbortSignal,
    ): Promise<void>;
    assertOpen(signal: AbortSignal): void;
  }>,
): Promise<PluginExecutionIoOwner | null> {
  const io = input.config;
  if (!io) {
    if (input.media) fail("installed_plugin_media_io_unavailable");
    return null;
  }
  const network = await io.resolveNetwork(input.context, input.signal);
  input.assertOpen(input.signal);
  await input.authorize(input.purpose, input.signal);
  if (network === null) {
    if (input.media) fail("installed_plugin_media_io_unavailable");
    return null;
  }
  const owner = new PluginExecutionIoOwner({
    ...io,
    context: input.context,
    approvalRequirement: input.approvalRequirement,
    network,
    ...(input.media
      ? { projectMedia: input.media, operations: input.media.operations }
      : {}),
    authorize: async (operation) => {
      await input.authorize(operation.purpose, operation.signal);
      const current = await io.resolveNetwork(input.context, operation.signal);
      operation.signal.throwIfAborted();
      if (
        current === null ||
        extensionCanonicalJson(captureNetworkApproval(current)) !==
          extensionCanonicalJson(owner.networkApproval)
      )
        fail("installed_plugin_runtime_network_denied");
      await input.authorize(operation.purpose, operation.signal);
    },
  });
  return owner;
}
