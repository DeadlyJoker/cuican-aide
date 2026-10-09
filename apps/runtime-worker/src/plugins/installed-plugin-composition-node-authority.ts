import type {
  ActorContext,
  AuthorizationPort,
  PluginInstallationStore,
} from "@crewon/application";
import type { PluginCompositionLock } from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  type InstalledPluginPackage,
} from "@crewon/domain";
import { readInstalledPluginRunSelection } from "./installed-plugin-run-selection.ts";
import { InstalledPluginRunContextError } from "./installed-plugin-run-context-error.ts";

function fail(code: string): never {
  throw new InstalledPluginRunContextError(code);
}

/** Host-only adapter. The caller supplies its genuine snapshot's parsed original graph and current Run authority. */
export async function authorizeInstalledPluginCompositionNode(
  input: Readonly<{
    lock: PluginCompositionLock;
    rootPluginId: string;
    pluginId: string;
    installations: PluginInstallationStore;
    authorization: AuthorizationPort;
    purpose: "submit" | "observe";
    signal: AbortSignal;
    assertRun(): Promise<void>;
    resolveActor(): Promise<ActorContext>;
  }>,
): Promise<InstalledPluginPackage> {
  const { lock, signal, purpose, installations } = input;
  const needed = new Set([input.rootPluginId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of lock.edges) {
      if (
        needed.has(edge.consumerPluginId) &&
        edge.provider.kind === "plugin" &&
        !needed.has(edge.provider.pluginId)
      ) {
        needed.add(edge.provider.pluginId);
        expanded = true;
      }
    }
  }
  const node = lock.nodes.find((value) => value.pluginId === input.pluginId);
  if (!node || !needed.has(node.pluginId))
    fail("installed_plugin_composition_node_unavailable");
  const scope = parsePluginProfileScope({
    tenantId: lock.scope.tenantId,
    spaceId: lock.scope.spaceId,
    profileId: lock.scope.profileId,
  });
  const pin = {
    ...scope,
    pluginId: node.pluginId,
    publisherId: node.publisherId,
    packageDigest: node.packageDigest,
    selectionRevision: node.selectionRevision,
  };
  signal.throwIfAborted();
  await input.assertRun();
  signal.throwIfAborted();
  const raw = await installations.loadPackage({
    scope,
    packageDigest: node.packageDigest,
  });
  signal.throwIfAborted();
  if (raw === null) fail("installed_plugin_package_missing");
  const pkg = parseInstalledPluginPackage(raw);
  for (const field of ["tenantId", "spaceId", "profileId"] as const)
    if (pkg[field] !== scope[field]) fail("installed_plugin_package_mismatch");
  for (const field of [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ] as const)
    if (pkg[field] !== node[field]) fail("installed_plugin_package_mismatch");
  const selection = await readInstalledPluginRunSelection(
    installations,
    pin,
    purpose,
    signal,
  );
  const actor = await input.resolveActor();
  signal.throwIfAborted();
  const decision = await input.authorization.authorize({
    actor,
    action: purpose === "submit" ? "extension:run" : "extension:query",
    resource: {
      kind: "extension",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: node.pluginId,
    },
  });
  signal.throwIfAborted();
  const outcome = Object.getOwnPropertyDescriptor(decision, "outcome");
  if (
    !outcome?.enumerable ||
    !("value" in outcome) ||
    outcome.value !== "allow"
  )
    fail("installed_plugin_execution_access_denied");
  // The root's policy refresh can await external work too; reread the provider afterwards.
  await input.assertRun();
  signal.throwIfAborted();
  const latest = await readInstalledPluginRunSelection(
    installations,
    pin,
    purpose,
    signal,
  );
  if (extensionCanonicalJson(selection) !== extensionCanonicalJson(latest))
    fail("installed_plugin_selection_changed");
  const latestActor = await input.resolveActor();
  if (extensionCanonicalJson(actor) !== extensionCanonicalJson(latestActor))
    fail("installed_plugin_execution_identity_unavailable");
  signal.throwIfAborted();
  return pkg;
}
