import { canonicalJsonValue } from "./canonical-json.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parsePluginCompositionLock,
  pluginCompositionActivationOrder,
  type PluginCompositionDigester,
  type PluginCompositionLock,
} from "./plugin-composition-lock.ts";

export type PluginCompositionTransition = Readonly<{
  previousLockDigest: string | null;
  nextLockDigest: string;
  /** Direct changes plus consumers in either graph. This is not an authorization grant. */
  affectedPluginIds: readonly string[];
  /** Existing consumers before their providers; old leases remain owned by the host. */
  withdrawOrder: readonly string[];
  /** Desired providers before consumers. Each preparation/publication needs fresh authority. */
  prepareOrder: readonly string[];
  retainedPluginIds: readonly string[];
}>;

function fingerprint(lock: PluginCompositionLock, pluginId: string): string {
  return canonicalJsonValue({
    node: lock.nodes.find((node) => node.pluginId === pluginId)!,
    edges: lock.edges.filter((edge) => edge.consumerPluginId === pluginId),
  });
}

/** Pure, bounded metadata planning. Does not activate code, persist a head, release resources or revive revoked authority. */
export function planPluginCompositionTransition(
  previousInput: unknown | null,
  nextInput: unknown,
  digester: PluginCompositionDigester,
): PluginCompositionTransition {
  const previous =
    previousInput === null
      ? null
      : parsePluginCompositionLock(previousInput, digester);
  const next = parsePluginCompositionLock(nextInput, digester);
  if (previous !== null) {
    for (const field of ["tenantId", "spaceId", "profileId"] as const)
      if (previous.scope[field] !== next.scope[field])
        throw new ContractValidationError(
          "plugin_composition_transition_scope_conflict",
        );
    if (
      next.lockDigest !== previous.lockDigest &&
      next.revision <= previous.revision
    )
      throw new ContractValidationError(
        "plugin_composition_transition_revision_conflict",
      );
  }
  const previousIds = new Set(previous?.nodes.map((node) => node.pluginId));
  const nextIds = new Set(next.nodes.map((node) => node.pluginId));
  const affected = new Set<string>();
  const epochChanged =
    previous?.scope.authorityEpoch !== next.scope.authorityEpoch;
  for (const pluginId of new Set([...previousIds, ...nextIds]))
    if (
      epochChanged ||
      !previousIds.has(pluginId) ||
      !nextIds.has(pluginId) ||
      fingerprint(previous!, pluginId) !== fingerprint(next, pluginId)
    )
      affected.add(pluginId);
  // Union of old and desired edges: neither an old consumer nor a new one may
  // stay bound to an affected provider. Includes optional dependencies when present.
  const edges = [...(previous?.edges ?? []), ...next.edges];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of edges)
      if (
        edge.provider.kind === "plugin" &&
        affected.has(edge.provider.pluginId) &&
        !affected.has(edge.consumerPluginId)
      ) {
        affected.add(edge.consumerPluginId);
        expanded = true;
      }
  }
  const previousOrder =
    previous === null
      ? []
      : pluginCompositionActivationOrder(previous, digester);
  const nextOrder = pluginCompositionActivationOrder(next, digester);
  return Object.freeze({
    previousLockDigest: previous?.lockDigest ?? null,
    nextLockDigest: next.lockDigest,
    affectedPluginIds: Object.freeze([...affected].sort()),
    withdrawOrder: Object.freeze(
      [...previousOrder].reverse().filter((id) => affected.has(id)),
    ),
    prepareOrder: Object.freeze(nextOrder.filter((id) => affected.has(id))),
    retainedPluginIds: Object.freeze(
      nextOrder.filter((id) => !affected.has(id)),
    ),
  });
}
