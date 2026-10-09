import { canonicalJsonValue } from "./canonical-json.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  copyPluginControlJson,
  pluginControlRecord,
  pluginControlRevision,
} from "./plugin-control-contract-support.ts";
import {
  compositionArray,
  compositionDigest,
  compositionEdge,
  compositionFail,
  compositionHostService,
  compositionNode,
  compositionScope,
  codeUnitCompare,
} from "./plugin-composition-lock-validation.ts";
import {
  compositionEdges,
  compositionActivationOrder,
} from "./plugin-composition-lock-graph.ts";
import {
  PLUGIN_COMPOSITION_LOCK_SCHEMA,
  PLUGIN_COMPOSITION_LOCK_LIMITS as limits,
  type PluginCompositionDigester,
  type PluginCompositionLock,
  type PluginCompositionLockBody,
} from "./plugin-composition-lock-types.ts";
export * from "./plugin-composition-lock-types.ts";

const fields = [
  "schemaVersion",
  "scope",
  "revision",
  "nodes",
  "hostServices",
] as const;

function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof ContractValidationError &&
      error.code.startsWith("plugin_composition_")
    )
      throw error;
    return compositionFail();
  }
}
function copy(input: unknown): unknown {
  return copyPluginControlJson(input, {
    maxBytes: limits.bytes,
    maxNodes: limits.jsonNodes,
  });
}
function body(
  value: Readonly<Record<string, unknown>>,
): PluginCompositionLockBody {
  if (value.schemaVersion !== PLUGIN_COMPOSITION_LOCK_SCHEMA)
    compositionFail("plugin_composition_schema_unsupported");
  const nodes = Object.freeze(
    compositionArray(value.nodes, limits.plugins)
      .map(compositionNode)
      .sort((a, b) => codeUnitCompare(a.pluginId, b.pluginId)),
  );
  const hostServices = Object.freeze(
    compositionArray(value.hostServices, limits.hostServices)
      .map(compositionHostService)
      .sort(
        (a, b) =>
          codeUnitCompare(a.service, b.service) ||
          codeUnitCompare(a.apiVersion, b.apiVersion),
      ),
  );
  return Object.freeze({
    schemaVersion: PLUGIN_COMPOSITION_LOCK_SCHEMA,
    scope: compositionScope(value.scope),
    revision: pluginControlRevision(value.revision),
    nodes,
    hostServices,
    edges: compositionEdges(nodes, hostServices),
  });
}
function digest(
  value: PluginCompositionLockBody,
  digester: PluginCompositionDigester,
): string {
  if (typeof digester?.sha256 !== "function") compositionFail();
  return compositionDigest(digester.sha256(canonicalJsonValue(value)));
}

/** Creates an immutable metadata lock. Actual package verification and admission remain host responsibilities. */
export function createPluginCompositionLock(
  input: unknown,
  digester: PluginCompositionDigester,
): PluginCompositionLock {
  return checked(() => {
    const value = body(pluginControlRecord(copy(input), fields));
    // Derived edges also consume the wire budget. A creator must never produce
    // a lock that its own parser cannot read; the digest has a fixed byte length.
    copy({ ...value, lockDigest: `sha256:${"0".repeat(64)}` });
    return Object.freeze({ ...value, lockDigest: digest(value, digester) });
  });
}

/** Strict adjacent protocol; never repairs a missing edge or overrides the stored provider identity. */
export function parsePluginCompositionLock(
  input: unknown,
  digester: PluginCompositionDigester,
): PluginCompositionLock {
  return checked(() => {
    const value = pluginControlRecord(copy(input), [
      ...fields,
      "edges",
      "lockDigest",
    ]);
    const parsed = body(value);
    const edges = compositionArray(
      value.edges,
      limits.plugins * limits.servicesPerPlugin,
    )
      .map(compositionEdge)
      .sort(
        (a, b) =>
          codeUnitCompare(a.consumerPluginId, b.consumerPluginId) ||
          codeUnitCompare(a.service, b.service),
      );
    if (canonicalJsonValue(edges) !== canonicalJsonValue(parsed.edges))
      compositionFail("plugin_composition_binding_mismatch");
    const lockDigest = compositionDigest(value.lockDigest);
    if (digest(parsed, digester) !== lockDigest)
      compositionFail("plugin_composition_digest_mismatch");
    return Object.freeze({ ...parsed, lockDigest });
  });
}

/** Checks the stored lock before returning its deterministic provider-before-consumer order. */
export function pluginCompositionActivationOrder(
  input: unknown,
  digester: PluginCompositionDigester,
): readonly string[] {
  const lock = parsePluginCompositionLock(input, digester);
  return compositionActivationOrder(lock.nodes, lock.edges);
}
