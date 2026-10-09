import { createHash } from "node:crypto";
import {
  createPluginCompositionLock,
  parsePluginCompositionLock,
  type PluginCompositionLock,
  type PluginCompositionHostService,
  type PluginCompositionScope,
} from "@crewon/contracts/plugins";
import {
  CREWON_EXECUTION_SERVICE,
  CREWON_EXECUTION_API_VERSION,
  type PluginIdentity,
} from "@crewon/plugin-sdk/node";
import {
  PluginCompositionCoordinator,
  type PluginCompositionAuthority,
} from "./plugin-composition-coordinator.ts";
import type { PluginHostService } from "./plugin-node-host.ts";
import { PluginExecutionRegistry } from "./plugin-execution-registry.ts";
import type { PluginExecutionPackageBorrow } from "./plugin-execution-package.ts";
import { retainPluginExecutionFailureOwner } from "./plugin-execution-failure-owner.ts";

/** Exact host implementation identity; callers must record this in the original persisted graph. */
export const PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE: PluginCompositionHostService =
  Object.freeze({
    service: CREWON_EXECUTION_SERVICE,
    apiVersion: CREWON_EXECUTION_API_VERSION,
    implementationId: "crewon.execution-registry.v1",
    implementationRevision: 1,
  });
const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
type Authority = PluginCompositionAuthority &
  Required<Pick<PluginCompositionAuthority, "beforePublication">>;

/** Private execution graph reconstructed from one immutable original lock, never from today's selections. */
export class PluginExecutionComposition {
  readonly #lock: PluginCompositionLock;
  readonly #assemblyDigest: string;
  readonly #identity: PluginIdentity;
  readonly #coordinator: PluginCompositionCoordinator;
  readonly #registry: PluginExecutionRegistry;
  #closed = false;

  private constructor(input: {
    lock: PluginCompositionLock;
    assemblyDigest: string;
    identity: PluginIdentity;
    coordinator: PluginCompositionCoordinator;
    registry: PluginExecutionRegistry;
  }) {
    this.#lock = input.lock;
    this.#assemblyDigest = input.assemblyDigest;
    this.#identity = input.identity;
    this.#coordinator = input.coordinator;
    this.#registry = input.registry;
  }

  static async open(
    input: Readonly<{
      lock: unknown;
      /** Independently recovered from the authenticated Run locator/reference, not the graph's self-declared identity. */
      expectedScope: PluginCompositionScope;
      rootPluginId: string;
      installRoot: string;
      hostServices: readonly Readonly<{
        metadata: PluginCompositionHostService;
        implementation: PluginHostService;
      }>[];
      /** Each callback receives the original full graph, not the derived execution slice. */
      authority: Authority;
    }>,
  ): Promise<PluginExecutionComposition> {
    const lock = parsePluginCompositionLock(input.lock, digester);
    const expected = createPluginCompositionLock(
      {
        schemaVersion: lock.schemaVersion,
        scope: input.expectedScope,
        revision: 1,
        nodes: [],
        hostServices: [],
      },
      digester,
    ).scope;
    if (JSON.stringify(expected) !== JSON.stringify(lock.scope))
      throw new Error("plugin_execution_composition_scope_conflict");
    const rootPluginId = input.rootPluginId;
    const root = lock.nodes.find((node) => node.pluginId === rootPluginId);
    if (!root) throw new Error("plugin_execution_composition_root_unavailable");
    if (!Array.isArray(input.hostServices) || input.hostServices.length > 1023)
      throw new Error("plugin_execution_composition_host_services_invalid");
    const authorityInput = input.authority;
    const prepare = authorityInput.authorizePreparation;
    const publish = authorityInput.authorizePublication;
    const beforePublication = authorityInput.beforePublication;
    if (
      typeof prepare !== "function" ||
      typeof publish !== "function" ||
      typeof beforePublication !== "function"
    )
      throw new Error("plugin_execution_composition_authority_missing");
    const authority = Object.freeze({
      authorizePreparation: prepare.bind(authorityInput),
      authorizePublication: publish.bind(authorityInput),
      beforePublication: beforePublication.bind(authorityInput),
    });
    // Only the root and its original transitive providers run code. Unrelated
    // UI-only/disabled business modules are not loaded as a historical side effect.
    const required = new Set([root.pluginId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const edge of lock.edges)
        if (
          required.has(edge.consumerPluginId) &&
          edge.provider.kind === "plugin" &&
          !required.has(edge.provider.pluginId)
        ) {
          required.add(edge.provider.pluginId);
          expanded = true;
        }
    }
    const requiredHostKeys = new Set(
      lock.edges
        .filter(
          (edge) =>
            required.has(edge.consumerPluginId) &&
            edge.provider.kind === "host",
        )
        .map((edge) => JSON.stringify([edge.service, edge.apiVersion])),
    );
    const assembly = createPluginCompositionLock(
      {
        schemaVersion: lock.schemaVersion,
        scope: lock.scope,
        revision: lock.revision,
        nodes: lock.nodes.filter((node) => required.has(node.pluginId)),
        hostServices: lock.hostServices.filter((service) =>
          requiredHostKeys.has(
            JSON.stringify([service.service, service.apiVersion]),
          ),
        ),
      },
      digester,
    );
    const registry = new PluginExecutionRegistry({
      maximumFactories: required.size,
    });
    const coordinator = new PluginCompositionCoordinator({
      scope: expected,
      installRoot: input.installRoot,
      services: [
        {
          metadata: PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE,
          implementation: registry.hostService(),
        },
        ...input.hostServices.filter((entry) =>
          requiredHostKeys.has(
            JSON.stringify([entry.metadata.service, entry.metadata.apiVersion]),
          ),
        ),
      ],
    });
    try {
      const result = await coordinator.synchronize({
        lock: assembly,
        authority: {
          authorizePreparation: (candidate) =>
            authority.authorizePreparation(
              Object.freeze({ ...candidate, lock }),
            ),
          beforePublication: (candidate) =>
            authority.beforePublication(Object.freeze({ ...candidate, lock })),
          authorizePublication: (candidate) =>
            authority.authorizePublication(
              Object.freeze({ ...candidate, lock }),
            ),
        },
      });
      if (
        result.failures.length ||
        result.activePluginIds.length !== required.size
      )
        throw new Error("plugin_execution_composition_activation_failed");
      const identity: PluginIdentity = Object.freeze({
        pluginId: root.pluginId,
        version: root.version,
        packageDigest: root.packageDigest,
      });
      // Actual root registration is mandatory; an enabled graph is not a factory.
      const lease = coordinator.acquireCurrent({
        lockDigest: assembly.lockDigest,
        pluginId: root.pluginId,
        authorizeBorrow: () => "allow",
      });
      try {
        registry.acquire(lease);
      } finally {
        lease.release();
      }
      return new PluginExecutionComposition({
        lock,
        assemblyDigest: assembly.lockDigest,
        identity,
        coordinator,
        registry,
      });
    } catch (error) {
      registry.close();
      try {
        await coordinator.close();
      } catch (cleanupError) {
        const failed = new AggregateError(
          [error, cleanupError],
          "plugin_execution_composition_start_failed",
        );
        retainPluginExecutionFailureOwner(failed, {
          close: async () => {
            registry.close();
            await coordinator.close();
          },
        });
        throw failed;
      }
      throw error;
    }
  }

  get identity(): PluginIdentity {
    return this.#identity;
  }
  get lock(): PluginCompositionLock {
    return this.#lock;
  }

  acquire(
    input: Readonly<{
      lockDigest: string;
      purpose: "newOperation" | "historicalOperation";
      /** Must verify the actual original Run/configuration and current execution/recovery authority. */
      authorizeBorrow(
        input: Readonly<{
          lock: PluginCompositionLock;
          identity: PluginIdentity;
          purpose: "newOperation" | "historicalOperation";
        }>,
      ): "allow" | "deny";
    }>,
  ): PluginExecutionPackageBorrow {
    if (this.#closed) throw new Error("plugin_execution_composition_closed");
    const digest = input.lockDigest,
      purpose = input.purpose,
      authorizeBorrow = input.authorizeBorrow;
    if (
      digest !== this.#lock.lockDigest ||
      (purpose !== "newOperation" && purpose !== "historicalOperation") ||
      typeof authorizeBorrow !== "function"
    )
      throw new Error("plugin_execution_composition_borrow_invalid");
    const lease = this.#coordinator.acquireCurrent({
      lockDigest: this.#assemblyDigest,
      pluginId: this.#identity.pluginId,
      authorizeBorrow: (identity) =>
        authorizeBorrow(Object.freeze({ lock: this.#lock, identity, purpose })),
    });
    try {
      const factory = this.#registry.acquire(lease);
      return Object.freeze({
        identity: lease.identity,
        factory: Object.freeze({
          ...(factory.requiredServices === undefined
            ? {}
            : { requiredServices: factory.requiredServices }),
          create: (
            context: Parameters<typeof factory.create>[0],
            services?: Parameters<typeof factory.create>[1],
          ) => {
            const scopeProperty =
              context !== null && typeof context === "object"
                ? Object.getOwnPropertyDescriptor(context, "scope")
                : undefined;
            const scope =
              scopeProperty && "value" in scopeProperty
                ? scopeProperty.value
                : null;
            if (!scopeProperty?.enumerable || !("value" in scopeProperty))
              throw new Error(
                "plugin_execution_composition_context_scope_conflict",
              );
            for (const field of ["tenantId", "spaceId", "profileId"] as const) {
              const property =
                scope !== null && typeof scope === "object"
                  ? Object.getOwnPropertyDescriptor(scope, field)
                  : undefined;
              if (
                !property?.enumerable ||
                !("value" in property) ||
                property.value !== this.#lock.scope[field]
              )
                throw new Error(
                  "plugin_execution_composition_context_scope_conflict",
                );
            }
            return factory.create(context, services);
          },
        }),
        release: lease.release,
      });
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#registry.close();
    await this.#coordinator.close();
  }
}
