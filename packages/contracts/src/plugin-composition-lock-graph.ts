import {
  compositionFail,
  codeUnitCompare,
} from "./plugin-composition-lock-validation.ts";
import type {
  PluginCompositionEdge,
  PluginCompositionHostService,
  PluginCompositionNode,
} from "./plugin-composition-lock-types.ts";

/** Exact declarations only; this does not authorize, import or activate implementations. */
export function compositionEdges(
  nodes: readonly PluginCompositionNode[],
  hostServices: readonly PluginCompositionHostService[],
): readonly PluginCompositionEdge[] {
  if (
    new Set(nodes.map((n) => n.pluginId)).size !== nodes.length ||
    new Set(nodes.map((n) => n.packageDigest)).size !== nodes.length
  )
    compositionFail("plugin_composition_node_conflict");
  const hosts = new Map<string, PluginCompositionHostService>();
  for (const host of hostServices) {
    const key = JSON.stringify([host.service, host.apiVersion]);
    if (hosts.has(key)) compositionFail("plugin_composition_service_conflict");
    hosts.set(key, host);
  }
  const hostNames = new Set(hostServices.map((h) => h.service));
  const providers = new Map<
    string,
    { node: PluginCompositionNode; apiVersion: string }
  >();
  for (const node of nodes)
    for (const provision of node.provides) {
      if (hostNames.has(provision.service) || providers.has(provision.service))
        compositionFail("plugin_composition_service_conflict");
      providers.set(provision.service, {
        node,
        apiVersion: provision.apiVersion,
      });
    }
  const edges = nodes.flatMap((node) =>
    node.requires.map((requirement): PluginCompositionEdge => {
      const host = hosts.get(
        JSON.stringify([requirement.service, requirement.apiVersion]),
      );
      const plugin = providers.get(requirement.service);
      let provider: PluginCompositionEdge["provider"];
      if (host)
        provider = Object.freeze({
          kind: "host",
          implementationId: host.implementationId,
          implementationRevision: host.implementationRevision,
        });
      else if (plugin?.apiVersion === requirement.apiVersion)
        provider = Object.freeze({
          kind: "plugin",
          pluginId: plugin.node.pluginId,
          packageDigest: plugin.node.packageDigest,
        });
      else if (requirement.optional)
        provider = Object.freeze({ kind: "absent" });
      else compositionFail("plugin_composition_dependency_unavailable");
      return Object.freeze({
        consumerPluginId: node.pluginId,
        service: requirement.service,
        apiVersion: requirement.apiVersion,
        provider,
      });
    }),
  );
  compositionActivationOrder(nodes, edges);
  return Object.freeze(edges);
}

export function compositionActivationOrder(
  nodes: readonly PluginCompositionNode[],
  edges: readonly PluginCompositionEdge[],
): readonly string[] {
  const dependencies = new Map(
    nodes.map((node) => [node.pluginId, new Set<string>()]),
  );
  for (const edge of edges)
    if (edge.provider.kind === "plugin")
      dependencies.get(edge.consumerPluginId)!.add(edge.provider.pluginId);
  const visiting = new Set<string>(),
    visited = new Set<string>(),
    ordered: string[] = [];
  function visit(pluginId: string): void {
    if (visiting.has(pluginId))
      compositionFail("plugin_composition_dependency_cycle");
    if (visited.has(pluginId)) return;
    visiting.add(pluginId);
    for (const dependency of [...dependencies.get(pluginId)!].sort(
      codeUnitCompare,
    ))
      visit(dependency);
    visiting.delete(pluginId);
    visited.add(pluginId);
    ordered.push(pluginId);
  }
  for (const node of nodes) visit(node.pluginId);
  return Object.freeze(ordered);
}
