import {
  ApplicationError,
  PluginInstallationApplicationService,
  type ActorContext,
  type ApplicationClock,
  type ContentDigester,
} from "@crewon/application";
import {
  parsePluginSourceListResponse,
  type PluginSourceListQuery,
  type PluginSourceListResponse,
} from "@crewon/contracts";
import {
  extensionCanonicalJson,
  pluginInstallationOpaqueId,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import {
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  assertDesktopPluginSourceRegistry,
  type DesktopPluginSourceRegistry,
} from "./desktop-plugin-source-registry.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { installationSame } from "./production-plugin-installation-runtime-support.ts";
import { DesktopInstallationProfile } from "./desktop-plugin-installation-profile.ts";
import { DesktopInstalledPluginActivationOwner } from "./desktop-installed-plugin-activation-owner.ts";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";

type Method =
  | "install"
  | "select"
  | "getPackage"
  | "getSelection"
  | "listPackages"
  | "listSelections";
export type DesktopPluginInstallationService = Pick<
  PluginInstallationApplicationService,
  Method
> &
  Readonly<{
    listSources(
      actor: ActorContext,
      query: PluginSourceListQuery,
    ): Promise<PluginSourceListResponse>;
  }>;
export type DesktopPluginInstallationRuntime = Readonly<{
  service: DesktopPluginInstallationService;
  assertProfileOwnership(actor: ActorContext): void;
  assertProfileOwnershipForSelectionCommit(actor: ActorContext): void;
  bindActivation(owner: DesktopInstalledPluginActivationOwner): void;
  close(): Promise<void>;
}>;
const runtimes = new WeakMap<
  object,
  Readonly<{
    configuration: DesktopPluginConfiguration;
    registry: DesktopPluginSourceRegistry;
    authority: DesktopPluginAuthority;
    store: SqliteRunStore;
  }>
>();

/** Structural copies and another grant's coordinator never prove native profile ownership. */
export function assertDesktopPluginInstallationRuntime(
  value: unknown,
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    registry: DesktopPluginSourceRegistry;
    authority: DesktopPluginAuthority;
    store: SqliteRunStore;
  }>,
): asserts value is DesktopPluginInstallationRuntime {
  const issued =
    value !== null && typeof value === "object"
      ? runtimes.get(value)
      : undefined;
  if (issued === undefined)
    throw new Error("desktop_plugin_installation_runtime_required");
  if (
    issued.registry !== input.registry ||
    issued.authority !== input.authority ||
    issued.store !== input.store ||
    !installationSame(
      issued.configuration,
      parseDesktopPluginConfiguration(input.configuration),
    )
  )
    throw new Error(
      "desktop_plugin_installation_runtime_configuration_mismatch",
    );
}
type Dependencies = Readonly<{
  store: SqliteRunStore;
  clock: ApplicationClock;
  digester: ContentDigester;
  hostUiServices?: PluginUiHostServiceAvailabilityPort;
}>;
const inputFields: Record<Method, readonly string[]> = {
  install: [
    "sourceId",
    "expectedPluginId",
    "expectedPackageDigest",
    "expectedSelectionRevision",
    "idempotencyKey",
  ],
  select: [
    "pluginId",
    "state",
    "selectedPackageDigest",
    "expectedSelectionRevision",
    "idempotencyKey",
  ],
  getPackage: ["packageDigest"],
  getSelection: ["pluginId"],
  listPackages: ["pluginId", "afterPackageDigest", "limit"],
  listSelections: ["afterPluginId", "limit"],
};

/** Production resources are acquired lazily from the actual SQLite ledger, never a copied Store DTO. */
export async function createDesktopPluginInstallationRuntime(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    registry: DesktopPluginSourceRegistry;
    authority: DesktopPluginAuthority;
  }>,
  dependencies: Dependencies,
): Promise<DesktopPluginInstallationRuntime> {
  const configuration = parseDesktopPluginConfiguration(input.configuration);
  assertDesktopPluginSourceRegistry(input.registry, configuration);
  if (
    !(dependencies.store instanceof SqliteRunStore) ||
    typeof dependencies.clock?.now !== "function" ||
    typeof dependencies.digester?.sha256 !== "function"
  )
    throw new Error("desktop_plugin_installation_dependencies_invalid");
  const registry = input.registry;
  const hostUiServices = capturePluginUiHostServiceAvailability(
    dependencies.hostUiServices,
  );
  const store = dependencies.store;
  const ledger = store.pluginInstallationStore();
  const clock = Object.freeze({
    now: dependencies.clock.now.bind(dependencies.clock),
  });
  const digester = Object.freeze({
    sha256: dependencies.digester.sha256.bind(dependencies.digester),
  });
  const authority = input.authority;
  const profiles = new Map<string, Promise<DesktopInstallationProfile>>();
  let activation: DesktopInstalledPluginActivationOwner | null = null;
  const prepareBusinessCandidate: DesktopInstallationProfile["prepareBusinessCandidate"] =
    (input, signal) =>
      activation === null
        ? Promise.resolve(null)
        : activation.prepareSelection(input, signal);
  // Claim the actual file-backed profile before exposing either installation or UI routes.
  // This also rejects :memory: and competing Control owners at startup.
  const initialScope = await authority.profile(configuration.actor);
  const initialProfile = await DesktopInstallationProfile.open({
    configuration,
    registry,
    authority,
    ledger,
    clock,
    digester,
    scope: initialScope,
    prepareBusinessCandidate,
    hostUiServices,
  });
  profiles.set(
    extensionCanonicalJson(initialScope),
    Promise.resolve(initialProfile),
  );
  const resolvedProfiles = new Set([initialProfile]);
  const physical = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | null = null;
  const available = () => {
    if (closed) conflict("plugin_installation_runtime_closed");
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    physical.add(work);
    void work.finally(() => physical.delete(work)).catch(() => {});
    return work;
  };
  const profile = async (actor: ActorContext) => {
    available();
    const scope = await authority.profile(actor);
    available();
    const key = extensionCanonicalJson(scope);
    let pending = profiles.get(key);
    if (pending === undefined) {
      if (profiles.size >= 32)
        conflict("plugin_installation_profile_capacity_exhausted");
      pending = DesktopInstallationProfile.open({
        configuration,
        registry,
        authority,
        ledger,
        clock,
        digester,
        scope,
        prepareBusinessCandidate,
        hostUiServices,
      }).then((current) => {
        resolvedProfiles.add(current);
        if (closed) current.withdraw();
        return current;
      });
      profiles.set(key, pending);
      void pending.catch(() => {
        if (profiles.get(key) === pending) profiles.delete(key);
      });
    }
    const current = await pending;
    available();
    return current;
  };
  const invoke = <M extends Method>(
    method: M,
    actorInput: ActorContext,
    inputValue: Parameters<PluginInstallationApplicationService[M]>[1],
  ): Promise<Awaited<ReturnType<PluginInstallationApplicationService[M]>>> => {
    available();
    const actor = pluginSecurityActor(actorInput);
    const command = pluginSecurityRecord(inputValue, inputFields[method]);
    if (physical.size >= 128) conflict("plugin_installation_runtime_busy");
    return track(
      (async () => {
        const current = await profile(actor);
        return current.run(actor, method, command);
      })(),
    ) as Promise<Awaited<ReturnType<PluginInstallationApplicationService[M]>>>;
  };
  const service: DesktopPluginInstallationService = Object.freeze({
    install: (actor, value) => invoke("install", actor, value),
    select: (actor, value) => invoke("select", actor, value),
    getPackage: (actor, value) => invoke("getPackage", actor, value),
    getSelection: (actor, value) => invoke("getSelection", actor, value),
    listPackages: (actor, value) => invoke("listPackages", actor, value),
    listSelections: (actor, value) => invoke("listSelections", actor, value),
    listSources: (actorInput, inputValue) => {
      available();
      const actor = pluginSecurityActor(actorInput);
      const fields = pluginSecurityRecord(inputValue, [
        "afterSourceId",
        "limit",
      ]);
      const afterSourceId =
        fields.afterSourceId === null
          ? null
          : pluginInstallationOpaqueId(fields.afterSourceId);
      if (
        !Number.isSafeInteger(fields.limit) ||
        (fields.limit as number) < 1 ||
        (fields.limit as number) > 50
      )
        throw new ApplicationError(
          "validation",
          "plugin_control_limit_invalid",
        );
      const query = Object.freeze({
        afterSourceId,
        limit: fields.limit as number,
      });
      if (physical.size >= 128) conflict("plugin_installation_runtime_busy");
      return track(
        (async () => {
          const scope = await authority.profile(actor);
          available();
          const before = await authority.epoch({
            actor,
            scope,
            action: "pluginInstallation:read",
            pluginId: null,
            packageDigest: null,
          });
          if (!installationSame(await authority.profile(actor), scope))
            denied("plugin_profile_changed");
          const after = await authority.epoch({
            actor,
            scope,
            action: "pluginInstallation:read",
            pluginId: null,
            packageDigest: null,
          });
          if (!installationSame(await authority.profile(actor), scope))
            denied("plugin_profile_changed");
          available();
          if (before !== after) denied("plugin_installation_authority_changed");
          const values = registry
            .list()
            .filter(
              (item) =>
                query.afterSourceId === null ||
                item.sourceId > query.afterSourceId,
            );
          const sources = values.slice(0, query.limit);
          return parsePluginSourceListResponse(
            {
              sources,
              next:
                values.length > sources.length
                  ? sources.at(-1)!.sourceId
                  : null,
            },
            query,
          );
        })(),
      );
    },
  });
  const runtime = Object.freeze({
    service,
    assertProfileOwnership: (actorInput: ActorContext) => {
      available();
      const actor = pluginSecurityActor(actorInput);
      authority.assertScope(actor, initialScope);
      initialProfile.assertOwnership(actor);
      available();
      authority.assertScope(actor, initialScope);
    },
    assertProfileOwnershipForSelectionCommit: (actorInput: ActorContext) => {
      available();
      const actor = pluginSecurityActor(actorInput);
      authority.assertScope(actor, initialScope);
      initialProfile.assertOwnershipForSelectionCommit(actor);
      available();
      authority.assertScope(actor, initialScope);
    },
    bindActivation: (owner: DesktopInstalledPluginActivationOwner) => {
      available();
      if (
        activation !== null ||
        !(owner instanceof DesktopInstalledPluginActivationOwner)
      )
        denied("desktop_plugin_activation_binding_invalid");
      owner.assertBinding({
        configuration,
        registry,
        authority,
        store,
        installation: runtime,
      });
      activation = owner;
    },
    close: () => {
      if (closing !== null) return closing;
      closed = true;
      const authorityClosing = authority.close();
      // Withdraw every existing profile synchronously before waiting for physical work.
      for (const current of resolvedProfiles) current.withdraw();
      return (closing = (async () => {
        await Promise.allSettled([...physical]);
        await authorityClosing;
        const results = await Promise.allSettled(
          [...profiles.values()].map(async (pending) =>
            (await pending).close(),
          ),
        );
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "desktop_plugin_installation_cleanup_failed",
          );
      })());
    },
  });
  runtimes.set(
    runtime,
    Object.freeze({ configuration, registry, authority, store }),
  );
  return runtime;
}

function conflict(code: string): never {
  throw new ApplicationError("conflict", code);
}
function denied(code: string): never {
  throw new ApplicationError("authorization", code);
}
