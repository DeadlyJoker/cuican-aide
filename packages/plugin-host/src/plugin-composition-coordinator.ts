import { createHash } from "node:crypto";
import {
  createPluginCompositionLock,
  parsePluginCompositionLock,
  planPluginCompositionTransition,
  pluginCompositionActivationOrder,
  type PluginCompositionLock,
  type PluginCompositionNode,
  type PluginCompositionScope,
  type PluginCompositionHostService,
} from "@crewon/contracts/plugins";
import {
  PluginNodeHost,
  type PluginHostService,
  type PluginActivationCandidate,
  type PluginNodeCommitCandidate,
  type PluginNodeLease,
} from "./plugin-node-host.ts";

const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
export class PluginCompositionCoordinatorError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "PluginCompositionCoordinatorError";
  }
}
function fail(code: string): never {
  throw new PluginCompositionCoordinatorError(code);
}
const requirements = (node: Pick<PluginCompositionNode, "requires">): string =>
  JSON.stringify(
    node.requires
      .map((entry) =>
        JSON.stringify([entry.service, entry.apiVersion, entry.optional]),
      )
      .sort(),
  );
const provisions = (node: Pick<PluginCompositionNode, "provides">): string =>
  JSON.stringify(
    node.provides
      .map((entry) => JSON.stringify([entry.service, entry.apiVersion]))
      .sort(),
  );
export type PluginCompositionAuthority = Readonly<{
  authorizePreparation(
    input: Readonly<{
      lock: PluginCompositionLock;
      node: PluginCompositionNode;
      candidate: PluginActivationCandidate;
    }>,
  ): Promise<"allow" | "deny"> | "allow" | "deny";
  /** Synchronous host-owned fence; must check current durable selection and approval. */
  authorizePublication(
    input: Readonly<{
      lock: PluginCompositionLock;
      node: PluginCompositionNode;
      candidate: PluginNodeCommitCandidate;
    }>,
  ): "allow" | "deny";
}>;
export type PluginCompositionResult = Readonly<{
  lockDigest: string;
  activePluginIds: readonly string[];
  failures: readonly Readonly<{ pluginId: string; code: string }>[];
}>;

/** One host-owned profile/epoch. Owns its NodeHost; callers cannot mutate its service discovery directly. */
export class PluginCompositionCoordinator {
  readonly #host: PluginNodeHost;
  readonly #scope: PluginCompositionScope;
  readonly #hostServices: readonly PluginCompositionHostService[];
  readonly #installRoot: string;
  #previous: PluginCompositionLock | null = null;
  #requested: PluginCompositionLock | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #generation = 0;
  #closed = false;

  constructor(
    input: Readonly<{
      scope: PluginCompositionScope;
      installRoot: string;
      services: readonly Readonly<{
        metadata: PluginCompositionHostService;
        implementation: PluginHostService;
      }>[];
    }>,
  ) {
    const captured = createPluginCompositionLock(
      {
        schemaVersion: "crewon.plugin-composition-lock.v1",
        scope: input.scope,
        revision: 1,
        nodes: [],
        hostServices: input.services.map((entry) => entry.metadata),
      },
      digester,
    );
    if (typeof input.installRoot !== "string" || input.installRoot.length === 0)
      fail("plugin_composition_install_root_invalid");
    for (const entry of input.services)
      if (
        entry.metadata.service !== entry.implementation.service ||
        entry.metadata.apiVersion !== entry.implementation.apiVersion
      )
        fail("plugin_composition_host_service_conflict");
    this.#scope = captured.scope;
    this.#hostServices = captured.hostServices;
    this.#installRoot = input.installRoot;
    this.#host = new PluginNodeHost({
      services: input.services.map((entry) => entry.implementation),
    });
  }

  /** Explicit desired graph plus fresh host authority. Saving a graph alone never calls this method. */
  synchronize(
    input: Readonly<{ lock: unknown; authority: PluginCompositionAuthority }>,
  ): Promise<PluginCompositionResult> {
    try {
      if (this.#closed) fail("plugin_composition_closed");
      const lock = parsePluginCompositionLock(input.lock, digester);
      if (JSON.stringify(lock.scope) !== JSON.stringify(this.#scope))
        fail("plugin_composition_scope_conflict");
      if (
        JSON.stringify(lock.hostServices) !== JSON.stringify(this.#hostServices)
      )
        fail("plugin_composition_host_service_conflict");
      if (this.#requested)
        planPluginCompositionTransition(this.#requested, lock, digester);
      const prepare = input.authority.authorizePreparation;
      const publish = input.authority.authorizePublication;
      if (typeof prepare !== "function" || typeof publish !== "function")
        fail("plugin_composition_authority_missing");
      if (this.#pending >= 64) fail("plugin_composition_pending_limit");
      const authority = Object.freeze({
        authorizePreparation: prepare.bind(input.authority),
        authorizePublication: publish.bind(input.authority),
      });
      const generation = ++this.#generation;
      this.#requested = lock;
      this.#pending++;
      const work = this.#queue
        .then(() => this.#apply(lock, authority, generation))
        .finally(() => {
          this.#pending--;
        });
      this.#queue = work.catch(() => undefined);
      return work;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Never coalesced away: synchronously cancels pending publication and withdraws the provider's consumers. */
  revoke(pluginId: string): void {
    if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(pluginId))
      fail("plugin_composition_plugin_id_invalid");
    this.#generation++;
    this.#host.deactivate(pluginId);
  }

  acquireCurrent(
    input: Readonly<{
      lockDigest: string;
      pluginId: string;
      authorizeBorrow: Parameters<
        PluginNodeHost["acquire"]
      >[0]["authorizeBorrow"];
    }>,
  ): PluginNodeLease {
    const lockDigest = input.lockDigest;
    const pluginId = input.pluginId;
    const authorizeBorrow = input.authorizeBorrow;
    const generation = this.#generation;
    const lock = this.#requested;
    if (
      this.#closed ||
      this.#pending !== 0 ||
      !lock ||
      lock.lockDigest !== lockDigest ||
      this.#previous?.lockDigest !== lockDigest
    )
      fail("plugin_composition_current_unavailable");
    const node = lock.nodes.find((entry) => entry.pluginId === pluginId);
    if (!node) fail("plugin_composition_current_unavailable");
    return this.#host.acquire({
      pluginId: node.pluginId,
      packageDigest: node.packageDigest,
      purpose: "newOperation",
      authorizeBorrow: (identity) => {
        this.#check(generation);
        if (typeof authorizeBorrow !== "function") return "deny";
        const result = authorizeBorrow(identity);
        this.#check(generation);
        return result;
      },
    });
  }

  /** Existing borrowed leases remain usable, but close cannot report success until they are released. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#generation++;
    for (const entry of this.#host.snapshot())
      this.#host.deactivate(entry.identity.pluginId);
    await this.#queue;
    await this.#host.close();
  }
  async drain(): Promise<void> {
    await this.#queue;
    await this.#host.drain();
  }
  #check(generation: number): void {
    if (this.#closed) fail("plugin_composition_closed");
    if (generation !== this.#generation) fail("plugin_composition_superseded");
  }
  #accepting(pluginId: string, digest: string): boolean {
    return this.#host
      .snapshot()
      .some(
        (entry) =>
          entry.phase === "accepting" &&
          entry.identity.pluginId === pluginId &&
          entry.identity.packageDigest === digest,
      );
  }
  #dependenciesMatch(
    lock: PluginCompositionLock,
    node: PluginCompositionNode,
    candidate: Pick<PluginNodeCommitCandidate, "dependencyIdentities">,
  ): boolean {
    const edges = lock.edges.filter(
      (edge) =>
        edge.consumerPluginId === node.pluginId &&
        edge.provider.kind !== "absent",
    );
    if (edges.length !== candidate.dependencyIdentities.length) return false;
    return edges.every((edge) => {
      const actual = candidate.dependencyIdentities.find(
        (entry) =>
          entry.service === edge.service &&
          entry.apiVersion === edge.apiVersion,
      );
      if (!actual) return false;
      if (edge.provider.kind === "host") return actual.provider === null;
      if (edge.provider.kind !== "plugin") return false;
      const providerIdentity = edge.provider;
      const provider = lock.nodes.find(
        (entry) => entry.pluginId === providerIdentity.pluginId,
      );
      return (
        actual.provider?.pluginId === provider?.pluginId &&
        actual.provider?.packageDigest === provider?.packageDigest &&
        actual.provider?.version === provider?.version
      );
    });
  }
  async #apply(
    lock: PluginCompositionLock,
    authority: PluginCompositionAuthority,
    generation: number,
  ): Promise<PluginCompositionResult> {
    this.#check(generation);
    const plan = planPluginCompositionTransition(
      this.#previous,
      lock,
      digester,
    );
    const affected = new Set(plan.affectedPluginIds);
    for (const node of lock.nodes)
      if (!this.#accepting(node.pluginId, node.packageDigest))
        affected.add(node.pluginId);
    // The NodeHost withdraws transitive consumers synchronously even for a partial previous attempt.
    for (const pluginId of plan.withdrawOrder) this.#host.deactivate(pluginId);
    for (const node of lock.nodes)
      if (affected.has(node.pluginId)) this.#host.deactivate(node.pluginId);
    this.#previous = lock;
    await this.#host.drain();
    this.#check(generation);
    const failures: { pluginId: string; code: string }[] = [];
    for (const pluginId of pluginCompositionActivationOrder(lock, digester)) {
      this.#check(generation);
      const node = lock.nodes.find((entry) => entry.pluginId === pluginId)!;
      // Retained instances still reverify bytes and both authority gates. The
      // NodeHost's same-package preparation does not rerun their setup.
      let prepared: Awaited<ReturnType<PluginNodeHost["prepare"]>> | null =
        null;
      let code = "plugin_composition_activation_failed";
      try {
        prepared = await this.#host.prepare({
          installRoot: this.#installRoot,
          expectedPluginId: pluginId,
          expectedPackageDigest: node.packageDigest,
          authorizeActivation: async (candidate) => {
            this.#check(generation);
            const descriptor = candidate.descriptor;
            if (
              descriptor.pluginId !== pluginId ||
              descriptor.publisherId !== node.publisherId ||
              descriptor.version !== node.version ||
              descriptor.hostApi !== node.hostApi ||
              candidate.packageDigest !== node.packageDigest ||
              requirements(descriptor) !== requirements(node) ||
              provisions(descriptor) !== provisions(node)
            ) {
              code = "plugin_composition_package_conflict";
              return "deny";
            }
            const result = await authority.authorizePreparation(
              Object.freeze({ lock, node, candidate }),
            );
            this.#check(generation);
            if (result !== "allow")
              code = "plugin_composition_authorization_denied";
            return result;
          },
        });
        this.#check(generation);
        if (!this.#dependenciesMatch(lock, node, prepared)) {
          code = "plugin_composition_dependency_conflict";
          fail(code);
        }
        prepared.commit({
          authorizeCommit: (candidate) => {
            this.#check(generation);
            const result = authority.authorizePublication(
              Object.freeze({ lock, node, candidate }),
            );
            this.#check(generation);
            if (result !== "allow")
              code = "plugin_composition_publication_denied";
            return result;
          },
        });
      } catch (error) {
        this.#host.deactivate(pluginId);
        await prepared?.abort();
        this.#check(generation);
        failures.push({ pluginId, code });
      }
    }
    await this.#host.drain();
    this.#check(generation);
    return Object.freeze({
      lockDigest: lock.lockDigest,
      activePluginIds: Object.freeze(
        lock.nodes
          .filter((node) => this.#accepting(node.pluginId, node.packageDigest))
          .map((node) => node.pluginId),
      ),
      failures: Object.freeze(failures.map((entry) => Object.freeze(entry))),
    });
  }
}
