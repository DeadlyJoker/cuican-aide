import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  capturePluginNodeHostServiceCatalog,
  PluginTaskActionBridge,
  type PluginActivationCandidate,
  type PluginNodeHostServiceCatalog,
  type PluginNodeLease,
} from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { canonicalDesktopPluginConfiguration } from "./desktop-plugin-configuration-canonical.ts";
import {
  assertDesktopPluginSourceRegistry,
  type DesktopPluginSourceRegistry,
} from "./desktop-plugin-source-registry.ts";
import {
  assertDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import {
  assertInstalledPluginTaskRuntimeCoreStore,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";

type Source = Readonly<{
  configuration: DesktopPluginConfiguration;
  registry: DesktopPluginSourceRegistry;
  authority: DesktopPluginAuthority;
  store: SqliteRunStore;
}>;
type PluginIdentity = PluginNodeLease["identity"];
type BindingContext = Parameters<
  NonNullable<
    ReturnType<PluginTaskActionBridge["hostService"]>["bindForPlugin"]
  >
>[1];
type TaskPort = Readonly<{
  createTask(input: unknown): unknown;
  queryTask(input: unknown): unknown;
}>;

/** Fixed transport wiring for the original Core. Owns no queue, instances, tasks or database. */
export class DesktopPluginTaskServiceBinding {
  readonly catalog: PluginNodeHostServiceCatalog;
  readonly #source: Source;
  #installation: DesktopPluginInstallationRuntime | null = null;
  #core: InstalledPluginTaskRuntimeCore | null = null;
  #bridge: PluginTaskActionBridge | null = null;
  #startup: Promise<void> | null = null;
  #closed = false;

  static isOwner(input: unknown): input is DesktopPluginTaskServiceBinding {
    return (
      input !== null &&
      typeof input === "object" &&
      #source in input &&
      Object.getPrototypeOf(input) ===
        DesktopPluginTaskServiceBinding.prototype &&
      Object.isFrozen(input)
    );
  }

  constructor(source: Source) {
    if (
      !(source.store instanceof SqliteRunStore) ||
      !(source.authority instanceof DesktopPluginAuthority)
    )
      unavailable();
    assertDesktopPluginSourceRegistry(source.registry, source.configuration);
    source.authority.assertScope(
      source.configuration.actor,
      source.configuration.scope,
    );
    this.#source = Object.freeze({ ...source });
    this.catalog = capturePluginNodeHostServiceCatalog(
      ["1", "2"].map((apiVersion) => ({
        metadata: {
          service: "crewon.tasks",
          apiVersion,
          implementationId: "crewon.desktop-task-core-binding.v1",
          implementationRevision: 1,
        },
        implementation: {
          service: "crewon.tasks",
          apiVersion,
          value: Object.freeze({
            createTask: () => unavailable(),
            ...(apiVersion === "2" ? { queryTask: () => unavailable() } : {}),
          }),
          bindForPlugin: (
            identity: PluginIdentity,
            lifecycle: BindingContext,
          ) => {
            this.#current();
            const service = (
              apiVersion === "1"
                ? this.#bridge!.hostService()
                : this.#bridge!.hostServiceV2()
            ).bindForPlugin!(identity, lifecycle) as TaskPort;
            return Object.freeze({
              createTask: (input: unknown) => {
                this.#current();
                return service.createTask(input);
              },
              ...(apiVersion === "2"
                ? {
                    queryTask: (input: unknown) => {
                      this.#current();
                      return service.queryTask(input);
                    },
                  }
                : {}),
            });
          },
        },
      })),
    );
    Object.freeze(this);
  }

  assertSource(source: Source): void {
    if (
      this.#closed ||
      source.store !== this.#source.store ||
      source.registry !== this.#source.registry ||
      source.authority !== this.#source.authority ||
      canonicalDesktopPluginConfiguration(source.configuration) !==
        canonicalDesktopPluginConfiguration(this.#source.configuration)
    )
      unavailable();
  }

  assertStore(store: unknown): void {
    if (this.#closed || store !== this.#source.store) unavailable();
  }

  bindInstallation(installation: DesktopPluginInstallationRuntime): void {
    if (this.#closed || this.#installation !== null) unavailable();
    assertDesktopPluginInstallationRuntime(installation, this.#source);
    this.#installation = installation;
  }

  bindCore(core: InstalledPluginTaskRuntimeCore): void {
    if (this.#closed || this.#core !== null || this.#installation === null)
      unavailable();
    assertInstalledPluginTaskRuntimeCoreStore(core, this.#source.store);
    const bridge = core.owner.sharedBridge(this);
    if (!PluginTaskActionBridge.isOwner(bridge)) unavailable();
    this.#bridge = bridge;
    this.#core = core;
  }

  bindStartup(work: Promise<void>): void {
    if (this.#closed || this.#startup !== null || !(work instanceof Promise))
      unavailable();
    this.#current();
    this.#startup = work;
  }

  async whenReady(): Promise<void> {
    this.#current();
    if (this.#startup === null) unavailable();
    await this.#startup;
    this.#current();
  }

  assertCandidate(candidate: PluginActivationCandidate): void {
    if (
      candidate.descriptor.entrypoints.node !== null &&
      candidate.descriptor.requires.some(
        (requirement) =>
          requirement.service === "crewon.tasks" &&
          ["1", "2"].includes(requirement.apiVersion),
      )
    )
      this.#current();
  }

  borrow(
    context: PluginUiActionContext,
    authorizeBorrow: (identity: PluginIdentity) => "allow" | "deny",
  ): Readonly<{ lease: PluginNodeLease; release(): void }> {
    this.#current();
    // UI task policy and Native composition have independent epochs. The bridge
    // checks the former; the original Profile proves the latter on every borrow.
    if (
      extensionCanonicalJson(context.scope) !==
      extensionCanonicalJson(this.#source.configuration.scope)
    )
      unavailable();
    return this.#installation!.borrowNode({
      actor: context.actor,
      scope: context.scope,
      pluginId: context.package.pluginId,
      packageDigest: context.package.packageDigest,
      authorizeBorrow,
    });
  }

  close(): void {
    this.#closed = true;
  }

  #current(): void {
    if (
      this.#closed ||
      this.#core === null ||
      this.#bridge === null ||
      this.#installation === null
    )
      unavailable();
    assertInstalledPluginTaskRuntimeCoreStore(this.#core, this.#source.store);
    this.#source.authority.assertScope(
      this.#source.configuration.actor,
      this.#source.configuration.scope,
    );
    this.#installation.assertProfileOwnership(this.#source.configuration.actor);
  }
}

function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_plugin_task_service_unavailable",
  );
}
