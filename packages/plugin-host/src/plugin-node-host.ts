import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  parsePluginNodeDefinition,
  type PluginDisposable,
  type PluginIdentity,
  type PluginNodeContext,
} from "@crewon/plugin-sdk/node";
import { verifyLocalPluginPackage } from "./local-plugin-package-verifier.ts";
import {
  assertDirectoryPins,
  pinDirectory,
} from "./local-plugin-package-files.ts";

export class PluginNodeHostError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "PluginNodeHostError";
    this.code = code;
  }
}

export type PluginHostService = Readonly<{
  service: string;
  apiVersion: string;
  value: object;
}>;
export type PluginActivationCandidate = Readonly<{
  descriptor: PluginPackageDescriptor;
  packageDigest: string;
}>;
export type PluginNodeActivation = Readonly<{
  /** Host-owned installation root; the immutable version path is derived from the digest. */
  installRoot: string;
  expectedPluginId: string;
  expectedPackageDigest: string;
  /** Host authority; self-declared publisher identity is not authorization. */
  authorizeActivation(
    candidate: PluginActivationCandidate,
  ): Promise<"allow" | "deny"> | "allow" | "deny";
}>;
export type PluginNodeLease = Readonly<{
  identity: PluginIdentity;
  getService<T extends object>(service: string, apiVersion: string): T;
  release(): void;
}>;
export type PluginNodeBorrow = Readonly<{
  pluginId: string;
  packageDigest: string;
  purpose: "newOperation" | "historicalOperation";
  /** The host must verify current admission or the original immutable Run binding. */
  authorizeBorrow(identity: PluginIdentity): "allow" | "deny";
}>;
type Service = PluginHostService & Readonly<{ owner: Instance | null }>;
type ActivationToken = { invalidated: boolean };
type Instance = {
  identity: PluginIdentity;
  descriptor: PluginPackageDescriptor;
  dependencies: Map<string, Service>;
  provisions: Map<string, Service>;
  cleanup: Array<() => void | Promise<void>>;
  phase:
    | "starting"
    | "accepting"
    | "retained"
    | "disposing"
    | "disposed"
    | "cleanupFailed";
  borrowers: number;
  setupOpen: boolean;
  failure: unknown;
};

/**
 * Trusted same-process ESM lifecycle. This is not a sandbox or a Run dispatcher.
 * Host services retain authorization responsibility for each individual call.
 */
export class PluginNodeHost {
  readonly #services = new Map<string, Service>();
  readonly #current = new Map<string, Instance>();
  readonly #instances = new Set<Instance>();
  readonly #cleanupTasks = new Set<Promise<void>>();
  readonly #pending = new Map<string, Set<ActivationToken>>();
  #pendingCount = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(input: Readonly<{ services: readonly PluginHostService[] }>) {
    if (input.services.length > 1024) fail("plugin_host_service_limit");
    for (const service of input.services) {
      checkService(service.service, service.apiVersion, service.value);
      if (this.#services.has(service.service)) fail("plugin_service_conflict");
      this.#services.set(
        service.service,
        Object.freeze({ ...service, owner: null }),
      );
    }
  }

  activate(input: PluginNodeActivation): Promise<PluginIdentity> {
    input = Object.freeze({ ...input });
    if (
      typeof input.expectedPluginId !== "string" ||
      !/^[a-z][a-z0-9._-]{0,127}$/u.test(input.expectedPluginId)
    )
      return Promise.reject(
        new PluginNodeHostError("plugin_node_expected_identity_invalid"),
      );
    if (this.#pendingCount >= 64)
      return Promise.reject(
        new PluginNodeHostError("plugin_host_activation_limit"),
      );
    const token = { invalidated: false };
    const pending =
      this.#pending.get(input.expectedPluginId) ?? new Set<ActivationToken>();
    pending.add(token);
    this.#pending.set(input.expectedPluginId, pending);
    this.#pendingCount += 1;
    const work = this.#queue
      .then(() => this.#activate(input, token))
      .finally(() => {
        pending.delete(token);
        this.#pendingCount -= 1;
        if (!pending.size) this.#pending.delete(input.expectedPluginId);
      });
    this.#queue = work.catch(() => undefined);
    return work;
  }

  /** Revokes new admission and service discovery synchronously; existing leases remain. */
  deactivate(pluginId: string): void {
    for (const token of this.#pending.get(pluginId) ?? [])
      token.invalidated = true;
    const instance = this.#current.get(pluginId);
    if (instance) this.#withdraw(instance);
  }

  acquire(input: PluginNodeBorrow): PluginNodeLease {
    input = Object.freeze({ ...input });
    if (this.#closed) fail("plugin_host_closed");
    if (
      input.purpose !== "newOperation" &&
      input.purpose !== "historicalOperation"
    )
      fail("plugin_borrow_purpose_invalid");
    const instance =
      input.purpose === "newOperation"
        ? this.#current.get(input.pluginId)
        : [...this.#instances]
            .reverse()
            .find(
              (candidate) =>
                candidate.identity.pluginId === input.pluginId &&
                candidate.identity.packageDigest === input.packageDigest &&
                (candidate.phase === "accepting" ||
                  candidate.phase === "retained"),
            );
    if (
      !instance ||
      instance.identity.packageDigest !== input.packageDigest ||
      (input.purpose === "newOperation" && instance.phase !== "accepting")
    )
      fail("plugin_instance_unavailable");
    if (
      typeof input.authorizeBorrow !== "function" ||
      input.authorizeBorrow(instance.identity) !== "allow"
    )
      fail("plugin_borrow_denied");
    // Authorization may synchronously revoke the same instance.
    if (
      this.#closed ||
      (instance.phase !== "accepting" && instance.phase !== "retained") ||
      (input.purpose === "newOperation" &&
        this.#current.get(input.pluginId) !== instance)
    )
      fail("plugin_instance_unavailable");
    instance.borrowers += 1;
    const leasedServices = new Map(
      [...instance.provisions].filter(
        ([name, service]) =>
          input.purpose === "historicalOperation" ||
          this.#services.get(name) === service,
      ),
    );
    let released = false;
    return Object.freeze({
      identity: instance.identity,
      getService<T extends object>(service: string, apiVersion: string): T {
        if (released) fail("plugin_lease_released");
        const value = leasedServices.get(service);
        if (!value || value.apiVersion !== apiVersion)
          fail("plugin_service_unavailable");
        return value.value as T;
      },
      release: () => {
        if (released) return;
        released = true;
        instance.borrowers -= 1;
        this.#retire(instance);
      },
    });
  }

  snapshot(): readonly Readonly<{
    identity: PluginIdentity;
    phase: Instance["phase"];
    borrowers: number;
  }>[] {
    return Object.freeze(
      [...this.#instances].map(({ identity, phase, borrowers }) =>
        Object.freeze({ identity, phase, borrowers }),
      ),
    );
  }

  /** Waits for cleanup that can run now. It never invents completion for borrowed instances. */
  async drain(): Promise<void> {
    await this.#queue;
    while (this.#cleanupTasks.size) await Promise.all([...this.#cleanupTasks]);
    const failures = [...this.#instances].filter(
      (instance) => instance.phase === "cleanupFailed",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map(({ failure }) => failure),
        "plugin_cleanup_failed",
      );
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const instance of [...this.#current.values()])
      this.#withdraw(instance);
    await this.drain();
    if ([...this.#instances].some(({ phase }) => phase !== "disposed"))
      fail("plugin_host_has_live_leases");
  }

  async #activate(
    input: PluginNodeActivation,
    token: ActivationToken,
  ): Promise<PluginIdentity> {
    this.#checkActivation(token);
    if (this.#instances.size >= 256) fail("plugin_host_instance_limit");
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.expectedPackageDigest))
      fail("plugin_package_digest_invalid");
    const root = await pinDirectory(input.installRoot);
    if (
      (typeof process.getuid === "function" &&
        root.stats.uid !== BigInt(process.getuid())) ||
      (root.stats.mode & 0o022n) !== 0n
    )
      fail("plugin_package_install_root_invalid");
    const directory = join(
      root.path,
      "packages",
      input.expectedPackageDigest.slice(7),
    );
    const verified = await verifyLocalPluginPackage({
      directory,
    });
    if (verified.directory !== directory)
      fail("plugin_package_install_root_invalid");
    this.#checkActivation(token);
    if (verified.descriptor.pluginId !== input.expectedPluginId)
      fail("plugin_node_identity_mismatch");
    if (verified.packageDigest !== input.expectedPackageDigest)
      fail("plugin_package_digest_mismatch");
    const candidate = Object.freeze({
      descriptor: verified.descriptor,
      packageDigest: verified.packageDigest,
    });
    if (
      typeof input.authorizeActivation !== "function" ||
      (await input.authorizeActivation(candidate)) !== "allow"
    )
      fail("plugin_activation_denied");
    this.#checkActivation(token);
    const descriptor = verified.descriptor;
    if (!descriptor.entrypoints.node) fail("plugin_node_entry_missing");
    const existing = this.#current.get(descriptor.pluginId);
    if (existing?.identity.packageDigest === verified.packageDigest)
      return existing.identity;
    const dependencies = new Map<string, Service>();
    for (const requirement of descriptor.requires) {
      const service = this.#services.get(requirement.service);
      if (!service || service.apiVersion !== requirement.apiVersion) {
        if (!requirement.optional) fail("plugin_dependency_unavailable");
      } else dependencies.set(requirement.service, service);
    }
    this.#checkConflicts(descriptor);
    this.#checkUpgradeDependencies(descriptor.pluginId, dependencies);
    const identity = Object.freeze({
      pluginId: descriptor.pluginId,
      version: descriptor.version,
      packageDigest: verified.packageDigest,
    });
    const instance: Instance = {
      identity,
      descriptor,
      dependencies,
      provisions: new Map(),
      cleanup: [],
      phase: "starting",
      borrowers: 0,
      setupOpen: true,
      failure: null,
    };
    for (const service of dependencies.values())
      if (service.owner) service.owner.borrowers += 1;
    this.#instances.add(instance);
    try {
      // Recheck after async host authorization and before executing any entry code.
      const checked = await verifyLocalPluginPackage({
        directory: verified.directory,
      });
      await assertDirectoryPins([root], false);
      if (checked.packageDigest !== verified.packageDigest)
        fail("plugin_package_changed_before_load");
      this.#checkActivation(token);
      this.#checkDependencies(instance);
      const imported: unknown = await import(
        pathToFileURL(resolve(verified.directory, descriptor.entrypoints.node))
          .href
      );
      const entry = parsePluginNodeDefinition(
        (imported as { default?: unknown }).default,
      );
      this.#checkActivation(token);
      if (entry.pluginId !== descriptor.pluginId)
        fail("plugin_node_identity_mismatch");
      const started = await entry.setup(this.#context(instance));
      if (started !== undefined) {
        if (
          !started ||
          typeof started !== "object" ||
          typeof started.dispose !== "function"
        )
          fail("plugin_node_disposer_invalid");
        instance.cleanup.push(() => started.dispose());
      }
      instance.setupOpen = false;
      this.#checkActivation(token);
      this.#checkDependencies(instance);
      this.#checkConflicts(descriptor);
      this.#checkUpgradeDependencies(descriptor.pluginId, dependencies);
      for (const provision of descriptor.provides)
        if (!instance.provisions.has(provision.service))
          fail("plugin_service_provision_missing");
      const previous = this.#current.get(descriptor.pluginId);
      if (previous) this.#withdraw(previous);
      instance.phase = "accepting";
      this.#current.set(descriptor.pluginId, instance);
      for (const service of instance.provisions.values())
        this.#services.set(service.service, service);
      return identity;
    } catch (error) {
      instance.setupOpen = false;
      instance.phase = "retained";
      this.#retire(instance);
      await this.drainCleanup();
      throw error;
    }
  }

  #context(instance: Instance): PluginNodeContext {
    const requireSetup = () => {
      if (!instance.setupOpen) fail("plugin_registration_closed");
    };
    return Object.freeze({
      identity: instance.identity,
      services: Object.freeze({
        get<T extends object>(service: string, apiVersion: string): T {
          const declaration = instance.descriptor.requires.find(
            (item) => item.service === service,
          );
          if (!declaration || declaration.apiVersion !== apiVersion)
            fail("plugin_dependency_undeclared");
          const value = instance.dependencies.get(service);
          if (!value) fail("plugin_dependency_unavailable");
          if (
            instance.phase === "disposed" ||
            instance.phase === "cleanupFailed"
          )
            fail("plugin_instance_unavailable");
          return value.value as T;
        },
        provide: <T extends object>(
          service: string,
          apiVersion: string,
          value: T,
        ): PluginDisposable => {
          requireSetup();
          checkService(service, apiVersion, value);
          const declaration = instance.descriptor.provides.find(
            (item) => item.service === service,
          );
          if (!declaration || declaration.apiVersion !== apiVersion)
            fail("plugin_provision_undeclared");
          if (instance.provisions.has(service)) fail("plugin_service_conflict");
          const record = Object.freeze({
            service,
            apiVersion,
            value,
            owner: instance,
          });
          instance.provisions.set(service, record);
          let disposed = false;
          return Object.freeze({
            dispose: () => {
              if (disposed) return;
              disposed = true;
              if (instance.setupOpen) instance.provisions.delete(service);
              if (this.#services.get(service) === record) {
                this.#services.delete(service);
                for (const consumer of [...this.#current.values()])
                  if (consumer.dependencies.get(service) === record)
                    this.#withdraw(consumer);
              }
            },
          });
        },
      }),
      onDispose: (callback: () => void | Promise<void>) => {
        requireSetup();
        if (typeof callback !== "function") fail("plugin_cleanup_invalid");
        if (instance.cleanup.length >= 1024) fail("plugin_cleanup_limit");
        instance.cleanup.push(callback);
      },
    });
  }

  #checkConflicts(descriptor: PluginPackageDescriptor): void {
    for (const provision of descriptor.provides) {
      const existing = this.#services.get(provision.service);
      if (existing && existing.owner?.identity.pluginId !== descriptor.pluginId)
        fail("plugin_service_conflict");
    }
  }
  #checkActivation(token: ActivationToken): void {
    if (this.#closed) fail("plugin_host_closed");
    if (token.invalidated) fail("plugin_activation_canceled");
  }
  #checkUpgradeDependencies(
    pluginId: string,
    dependencies: ReadonlyMap<string, Service>,
  ): void {
    const previous = this.#current.get(pluginId);
    if (!previous) return;
    const visited = new Set<Instance>();
    const reachesPrevious = (instance: Instance | null): boolean => {
      if (!instance) return false;
      if (instance === previous) return true;
      if (visited.has(instance)) return false;
      visited.add(instance);
      return [...instance.dependencies.values()].some(({ owner }) =>
        reachesPrevious(owner),
      );
    };
    if ([...dependencies.values()].some(({ owner }) => reachesPrevious(owner)))
      fail("plugin_dependency_upgrade_cycle");
  }
  #checkDependencies(instance: Instance): void {
    for (const [name, service] of instance.dependencies)
      if (this.#services.get(name) !== service)
        fail("plugin_dependency_changed_during_activation");
  }
  #withdraw(instance: Instance): void {
    if (instance.phase !== "accepting") return;
    instance.phase = "retained";
    if (this.#current.get(instance.identity.pluginId) === instance)
      this.#current.delete(instance.identity.pluginId);
    for (const service of instance.provisions.values())
      if (this.#services.get(service.service) === service)
        this.#services.delete(service.service);
    for (const consumer of [...this.#current.values()])
      if (
        [...consumer.dependencies.values()].some(
          ({ owner }) => owner === instance,
        )
      )
        this.#withdraw(consumer);
    this.#retire(instance);
  }
  #retire(instance: Instance): void {
    if (instance.phase !== "retained" || instance.borrowers !== 0) return;
    instance.phase = "disposing";
    // User cleanup runs after the synchronous selection/service transaction completes.
    const task = Promise.resolve().then(() => this.#cleanup(instance));
    this.#cleanupTasks.add(task);
    void task.finally(() => this.#cleanupTasks.delete(task));
  }
  async #cleanup(instance: Instance): Promise<void> {
    const failures: unknown[] = [];
    for (const cleanup of instance.cleanup.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      instance.phase = "cleanupFailed";
      instance.failure = new AggregateError(failures, "plugin_cleanup_failed");
      return; // Retain dependency leases: failed cleanup is not proof resources are gone.
    }
    instance.phase = "disposed";
    for (const service of instance.dependencies.values())
      if (service.owner) {
        service.owner.borrowers -= 1;
        this.#retire(service.owner);
      }
    this.#instances.delete(instance);
  }
  private async drainCleanup(): Promise<void> {
    while (this.#cleanupTasks.size) await Promise.all([...this.#cleanupTasks]);
  }
}

function checkService(
  service: string,
  apiVersion: string,
  value: object,
): void {
  if (
    typeof service !== "string" ||
    typeof apiVersion !== "string" ||
    !/^[a-z][a-z0-9._-]*$/u.test(service) ||
    service.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(apiVersion) ||
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    fail("plugin_host_service_invalid");
}
function fail(code: string): never {
  throw new PluginNodeHostError(code);
}
