import {
  ApplicationError,
  type ActorContext,
  type PluginInstallationApplicationService,
} from "@crewon/application";
import type {
  PluginCompositionStatusResponse,
  PluginSelectionListQuery,
} from "@crewon/contracts";
import type { PluginProfileScope } from "@crewon/domain";
import type { PluginNodeHost } from "@crewon/plugin-host";
import type { SqlitePluginInstallationProfileOwner } from "@crewon/store";
import type { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import type { DesktopPluginCompositionMetadataOwner } from "./desktop-plugin-composition-metadata-owner.ts";
import { projectDesktopPluginCompositionStatus } from "./desktop-plugin-composition-status-owner.ts";
import { installationSame } from "./production-plugin-installation-runtime-support.ts";

/** Runs only inside the original profile queue. Reads never import or restore plugin code. */
export async function captureDesktopPluginCompositionStatus(
  input: Readonly<{
    actor: ActorContext;
    scope: PluginProfileScope;
    query: PluginSelectionListQuery;
    owner: SqlitePluginInstallationProfileOwner;
    application: PluginInstallationApplicationService;
    registry: DesktopPluginSourceRegistry;
    metadata: DesktopPluginCompositionMetadataOwner;
    nodes: Pick<PluginNodeHost, "snapshot">;
    signal: AbortSignal;
    refreshAuthority(): Promise<string>;
  }>,
): Promise<PluginCompositionStatusResponse> {
  input.signal.throwIfAborted();
  const before = await input.refreshAuthority();
  const projection = input.owner.snapshot();
  const page = await input.application.listSelections(input.actor, input.query);
  input.signal.throwIfAborted();
  const nodes = input.nodes.snapshot();
  const metadata = input.metadata.state(input.actor);
  const after = await input.refreshAuthority();
  const confirmed = input.owner.snapshot();
  input.signal.throwIfAborted();
  if (before !== after || !installationSame(projection, confirmed))
    throw new ApplicationError(
      "authorization",
      "plugin_composition_status_changed",
    );
  for (const node of nodes) {
    const pkg = confirmed.selectedPackages.find(
      (entry) =>
        entry.pluginId === node.identity.pluginId &&
        entry.packageDigest === node.identity.packageDigest &&
        entry.version === node.identity.version,
    );
    if (
      node.phase === "accepting" &&
      (pkg === undefined || input.registry.authorizeIdentity(pkg) !== "allow")
    )
      throw new ApplicationError(
        "authorization",
        "plugin_composition_status_unapproved",
      );
  }
  return projectDesktopPluginCompositionStatus({
    scope: input.scope,
    query: input.query,
    projection: confirmed,
    page,
    nodes,
    metadata,
  });
}
