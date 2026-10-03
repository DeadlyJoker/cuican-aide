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
import { PostgresPluginInstallationStore } from "@crewon/store";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import {
  parseProductionPluginInstallationConfiguration,
  type ProductionPluginInstallationConfiguration,
} from "./production-plugin-installation-environment.ts";
import {
  assertProductionPluginSourceRegistry,
  type ProductionPluginSourceRegistry,
} from "./production-plugin-source-registry.ts";
import { ProductionPluginInstallationAuthority } from "./production-plugin-installation-authority.ts";
import { installationSame } from "./production-plugin-installation-runtime-support.ts";
import { InstallationProfile } from "./production-plugin-installation-profile.ts";

type Method =
  | "install"
  | "select"
  | "getPackage"
  | "getSelection"
  | "listPackages"
  | "listSelections";
export type ProductionPluginInstallationService = Pick<
  PluginInstallationApplicationService,
  Method
> &
  Readonly<{
    listSources(
      actor: ActorContext,
      query: PluginSourceListQuery,
    ): Promise<PluginSourceListResponse>;
  }>;
export type ProductionPluginInstallationRuntime = Readonly<{
  service: ProductionPluginInstallationService;
  close(): Promise<void>;
}>;
type Dependencies = Readonly<{
  ledger: PostgresPluginInstallationStore;
  clock: ApplicationClock;
  digester: ContentDigester;
  fetch?: typeof globalThis.fetch;
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

/** Production resources are acquired lazily from the actual PG ledger, never a copied Store DTO. */
export function createProductionPluginInstallationRuntime(
  input: Readonly<{
    configuration: ProductionPluginInstallationConfiguration;
    registry: ProductionPluginSourceRegistry;
  }>,
  dependencies: Dependencies,
): ProductionPluginInstallationRuntime {
  const configuration = parseProductionPluginInstallationConfiguration(
    input.configuration,
  );
  assertProductionPluginSourceRegistry(input.registry, configuration);
  if (
    !(dependencies.ledger instanceof PostgresPluginInstallationStore) ||
    typeof dependencies.clock?.now !== "function" ||
    typeof dependencies.digester?.sha256 !== "function" ||
    (dependencies.fetch !== undefined &&
      typeof dependencies.fetch !== "function")
  )
    throw new Error("production_plugin_installation_dependencies_invalid");
  const registry = input.registry;
  const clock = Object.freeze({
    now: dependencies.clock.now.bind(dependencies.clock),
  });
  const digester = Object.freeze({
    sha256: dependencies.digester.sha256.bind(dependencies.digester),
  });
  const authority = new ProductionPluginInstallationAuthority(
    configuration,
    dependencies.fetch,
  );
  const profiles = new Map<string, Promise<InstallationProfile>>();
  const resolvedProfiles = new Set<InstallationProfile>();
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
      pending = InstallationProfile.open({
        configuration,
        registry,
        authority,
        ledger: dependencies.ledger,
        clock,
        digester,
        scope,
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
  const service: ProductionPluginInstallationService = Object.freeze({
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
  return Object.freeze({
    service,
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
            "production_plugin_installation_cleanup_failed",
          );
      })());
    },
  });
}

function conflict(code: string): never {
  throw new ApplicationError("conflict", code);
}
function denied(code: string): never {
  throw new ApplicationError("authorization", code);
}
