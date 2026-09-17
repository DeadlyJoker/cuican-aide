import type { ThreadModelState } from "@crewon/application";
import type {
  AgentVersionRuntimeLocator,
  AgentVersionRuntimeResolverPort,
} from "./agent-version-runtime.ts";
import type { PriorModelCompactionResolverPort } from "./model-switch-compaction.ts";
import type { RuntimePreflight } from "./runtime-preflight.ts";
import {
  externalResourceLease,
  type RuntimeResourceScope,
} from "./runtime-resource-lease.ts";

/** Register a borrow inside the physical operation, before preflight can discard its result. */
export async function acquireRuntimeResource(input: {
  locator: AgentVersionRuntimeLocator;
  resolver: AgentVersionRuntimeResolverPort;
  scope: RuntimeResourceScope;
  preflight: RuntimePreflight;
}) {
  const { resolver, locator, scope, preflight } = input;
  const resident = resolver.acquireResident?.(locator);
  if (resident != null) return scope.use(resident);
  if (resolver.acquire === undefined) {
    const legacy = resolver.resolveResident?.(locator);
    if (legacy != null) return legacy;
  }
  return preflight.run({
    identity: {
      tenantId: locator.tenantId,
      kind: "runtime",
      resourceId: locator.agentVersionId,
    },
    operation: () =>
      scope.run(async () => {
        if (resolver.acquire !== undefined) {
          const lease = await resolver.acquire(locator);
          return lease === null ? null : scope.use(lease);
        }
        const runtime = await resolver.resolve(locator);
        return runtime === null
          ? null
          : scope.use(externalResourceLease(runtime));
      }),
  });
}

export async function acquirePriorCompactorResource(input: {
  prior: ThreadModelState;
  resolver: PriorModelCompactionResolverPort;
  scope: RuntimeResourceScope;
  preflight: RuntimePreflight;
}) {
  const { resolver, prior, scope, preflight } = input;
  return preflight.run({
    identity: {
      tenantId: prior.tenantId,
      kind: "priorCompactor",
      resourceId: prior.agentVersionId,
    },
    operation: () =>
      scope.run(async () => {
        if (resolver.acquire !== undefined) {
          const lease = await resolver.acquire(prior);
          return lease === null ? null : scope.use(lease);
        }
        const runtime = await resolver.resolve(prior);
        return runtime === null
          ? null
          : scope.use(externalResourceLease(runtime));
      }),
  });
}
