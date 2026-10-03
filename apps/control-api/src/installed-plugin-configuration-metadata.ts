import { createHash } from "node:crypto";
import { join } from "node:path";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  ApplicationError,
  type ActorContext,
  type ExtensionCatalogPort,
  type ExtensionHostPort,
  type ExtensionRegistration,
  type PluginInstallationStore,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  parseExtensionManifest,
  parseExtensionConfiguration,
  pluginInstallationNamespaceId,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import {
  loadInstalledPluginBusinessRegistration,
  revalidateInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  verifyLocalPluginPackage,
  type InstalledPluginBusinessRegistration,
  type PluginActivationCandidate,
} from "@crewon/plugin-host";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

export type InstalledPluginMetadataRequest =
  | Readonly<{ kind: "catalog" }>
  | Readonly<{ kind: "registration"; pluginId: string; pluginVersion: string }>;
export type InstalledPluginMetadataPrepared = Readonly<{
  catalog: ExtensionCatalogPort;
  host: ExtensionHostPort;
}>;
export interface InstalledPluginConfigurationMetadataPort {
  prepare(
    input: Readonly<{
      actor: ActorContext;
      scope: PluginProfileScope;
      request: InstalledPluginMetadataRequest;
    }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<InstalledPluginMetadataPrepared>;
}
type Entry = Readonly<{
  selection: PluginSelection;
  package: InstalledPluginPackage;
  registration: InstalledPluginBusinessRegistration;
}>;

/** Verified JSON metadata only. No Node import, readiness proof, tasks, or funding. */
export class InstalledPluginConfigurationMetadata
  implements InstalledPluginConfigurationMetadataPort
{
  readonly #root: string;
  readonly #store: Pick<
    PluginInstallationStore,
    "listSelections" | "loadSelection" | "loadPackage"
  >;
  readonly #maximum: number;
  readonly #authorizeRead: (
    input: Readonly<{
      actor: ActorContext;
      scope: PluginProfileScope;
      candidate: PluginActivationCandidate;
    }>,
    signal: AbortSignal,
  ) => Promise<"allow" | "deny">;
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  constructor(
    input: Readonly<{
      installRoot: string;
      installations: Pick<
        PluginInstallationStore,
        "listSelections" | "loadSelection" | "loadPackage"
      >;
      maximumPackages: number;
      authorizeRead(
        input: Readonly<{
          actor: ActorContext;
          scope: PluginProfileScope;
          candidate: PluginActivationCandidate;
        }>,
        signal: AbortSignal,
      ): Promise<"allow" | "deny">;
    }>,
  ) {
    const value = pluginSecurityRecord(input, [
      "installRoot",
      "installations",
      "maximumPackages",
      "authorizeRead",
    ]);
    if (
      !Number.isSafeInteger(value.maximumPackages) ||
      (value.maximumPackages as number) < 1 ||
      (value.maximumPackages as number) > 32 ||
      typeof value.installRoot !== "string" ||
      typeof value.authorizeRead !== "function"
    )
      fail("installed_plugin_metadata_configuration_invalid");
    this.#root = value.installRoot;
    const store = value.installations as typeof input.installations;
    this.#store = Object.freeze({
      listSelections: method(store, "listSelections"),
      loadSelection: method(store, "loadSelection"),
      loadPackage: method(store, "loadPackage"),
    });
    this.#maximum = value.maximumPackages as number;
    this.#authorizeRead = (
      value.authorizeRead as typeof input.authorizeRead
    ).bind(input);
  }
  prepare(
    input: Readonly<{
      actor: ActorContext;
      scope: PluginProfileScope;
      request: InstalledPluginMetadataRequest;
    }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<InstalledPluginMetadataPrepared> {
    const captured = pluginSecurityRecord(input, ["actor", "scope", "request"]);
    const actor = pluginSecurityActor(captured.actor);
    const scope = parsePluginProfileScope(captured.scope);
    if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
      denied();
    const rawRequest = parsePluginUiJsonValue(captured.request);
    const kind =
      rawRequest !== null && typeof rawRequest === "object"
        ? Object.getOwnPropertyDescriptor(rawRequest, "kind")?.value
        : undefined;
    const fields = pluginSecurityRecord(
      rawRequest,
      kind === "catalog" ? ["kind"] : ["kind", "pluginId", "pluginVersion"],
    );
    if (fields.kind !== "catalog" && fields.kind !== "registration") denied();
    const request: InstalledPluginMetadataRequest =
      fields.kind === "catalog"
        ? Object.freeze({ kind: "catalog" })
        : Object.freeze({
            kind: "registration",
            pluginId: pluginInstallationNamespaceId(fields.pluginId),
            pluginVersion: version(fields.pluginVersion),
          });
    return this.#operation(options.signal, async (signal) => {
      let selections: readonly PluginSelection[];
      if (request.kind === "registration") {
        const selected = await this.#store.loadSelection({
          scope,
          pluginId: request.pluginId,
        });
        selections = selected === null ? [] : [parsePluginSelection(selected)];
      } else {
        selections = await this.#selectedPackages(scope, signal);
      }
      signal.throwIfAborted();
      const entries: Entry[] = [];
      for (const selection of selections) {
        if (!same(scopeOf(selection), scope)) denied();
        if (selection.state === "uninstalled") continue;
        const pkg = await this.#package(scope, selection);
        signal.throwIfAborted();
        if (
          request.kind === "registration" &&
          (pkg.pluginId !== request.pluginId ||
            pkg.version !== request.pluginVersion)
        )
          continue;
        const authorizeRead = async (
          candidate: PluginActivationCandidate,
          currentSignal: AbortSignal,
        ) => {
          await this.#unchanged(scope, selection, pkg, currentSignal);
          const decision = await this.#authorizeRead(
            { actor, scope, candidate },
            currentSignal,
          );
          await this.#unchanged(scope, selection, pkg, currentSignal);
          return decision;
        };
        // A verified UI-only envelope is not a business registration. Corrupt bytes are never skipped.
        const verified = await verifyLocalPluginPackage({
          directory: join(this.#root, "packages", pkg.packageDigest.slice(7)),
          signal,
        });
        if (
          verified.packageDigest !== pkg.packageDigest ||
          verified.descriptor.pluginId !== pkg.pluginId ||
          verified.descriptor.publisherId !== pkg.publisherId ||
          verified.descriptor.version !== pkg.version
        )
          denied();
        if (verified.descriptor.businessManifestPath === null) {
          if (
            (await authorizeRead(
              {
                descriptor: verified.descriptor,
                packageDigest: verified.packageDigest,
              },
              signal,
            )) !== "allow"
          )
            denied();
          continue;
        }
        const registration = await loadInstalledPluginBusinessRegistration({
          installRoot: this.#root,
          expectedPluginId: pkg.pluginId,
          expectedPublisherId: pkg.publisherId,
          expectedVersion: pkg.version,
          expectedPackageDigest: pkg.packageDigest,
          authorizeRead,
          signal,
        });
        await this.#unchanged(scope, selection, pkg, signal);
        entries.push(Object.freeze({ selection, package: pkg, registration }));
      }
      // Later entries may await policy/files. Revalidate every earlier entry before exposing one catalog.
      for (const entry of entries) {
        await this.#unchanged(scope, entry.selection, entry.package, signal);
        await revalidateInstalledPluginBusinessRegistration(
          entry.registration,
          signal,
        );
        await this.#unchanged(scope, entry.selection, entry.package, signal);
      }
      const assertActive = () => {
        this.#lifetime.signal.throwIfAborted();
        signal.throwIfAborted();
      };
      const registrationFor = (
        identity: Readonly<{ pluginId: string; pluginVersion: string }>,
      ) => {
        assertActive();
        const pluginId = ownValue(identity, "pluginId"),
          pluginVersion = ownValue(identity, "pluginVersion");
        return (
          entries.find(
            (entry) =>
              entry.registration.manifest.pluginId === pluginId &&
              entry.registration.manifest.version === pluginVersion,
          )?.registration ?? null
        );
      };
      const checked = (registration: ExtensionRegistration) => {
        assertActive();
        const fields = pluginSecurityRecord(registration, [
          "manifest",
          "manifestDigest",
          "implementationDigest",
        ]);
        const copy = {
          manifest: parseExtensionManifest(fields.manifest),
          manifestDigest: fields.manifestDigest,
          implementationDigest: fields.implementationDigest,
        };
        const entry = entries.find((entry) =>
          same(project(entry.registration), copy),
        );
        if (entry === undefined) denied();
        return entry;
      };
      return Object.freeze({
        catalog: Object.freeze({
          list: () => {
            assertActive();
            return Object.freeze(
              entries.map((entry) => project(entry.registration)),
            );
          },
          resolve: (
            identity: Readonly<{ pluginId: string; pluginVersion: string }>,
          ) => {
            const found = registrationFor(identity);
            return found === null ? null : project(found);
          },
        }),
        host: Object.freeze({
          taskAdmissionMode: ({
            registration,
          }: Readonly<{ registration: ExtensionRegistration }>) => {
            checked(registration);
            return "installed" as const;
          },
          validateConfiguration: async (
            value: Parameters<ExtensionHostPort["validateConfiguration"]>[0],
          ) => {
            if (!same(pluginSecurityActor(value.actor), actor)) denied();
            const entry = checked(value.registration);
            const configuration = parseExtensionConfiguration(
              value.configuration,
              {
                sha256: (value) =>
                  `sha256:${createHash("sha256").update(value).digest("hex")}`,
              },
            );
            if (
              configuration.tenantId !== scope.tenantId ||
              configuration.spaceId !== scope.spaceId
            )
              denied();
            await this.#operation(signal, async (currentSignal) => {
              await this.#unchanged(
                scope,
                entry.selection,
                entry.package,
                currentSignal,
              );
              await revalidateInstalledPluginBusinessRegistration(
                entry.registration,
                currentSignal,
              );
              validateInstalledPluginConfiguration(
                entry.registration,
                configuration,
              );
              await this.#unchanged(
                scope,
                entry.selection,
                entry.package,
                currentSignal,
              );
            });
          },
          evaluate: async () => {
            assertActive();
            return {
              outcome: "unavailable" as const,
              reasonCode: "extension_runtime_unavailable" as const,
            };
          },
        }),
      });
    });
  }
  async #selectedPackages(
    scope: PluginProfileScope,
    signal: AbortSignal,
  ): Promise<readonly PluginSelection[]> {
    const selected: PluginSelection[] = [];
    let afterPluginId: string | null = null;
    // Logical uninstall preserves history. Bound its scan separately from live package verification.
    for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
      signal.throwIfAborted();
      const page = await this.#store.listSelections({
        scope,
        afterPluginId,
        limit: 50,
      });
      signal.throwIfAborted();
      if (!Array.isArray(page.selections) || page.selections.length > 50)
        fail("installed_plugin_metadata_page_invalid");
      let previous: string | null = afterPluginId;
      for (const item of page.selections) {
        const selection = parsePluginSelection(item);
        if (
          !same(scopeOf(selection), scope) ||
          (previous !== null && selection.pluginId <= previous)
        )
          denied();
        previous = selection.pluginId;
        if (selection.state === "uninstalled") continue;
        selected.push(selection);
        if (selected.length > this.#maximum)
          fail("installed_plugin_metadata_capacity_exceeded");
      }
      if (page.next === null) return Object.freeze(selected);
      if (
        typeof page.next !== "string" ||
        page.selections.length !== 50 ||
        page.next !== previous ||
        (afterPluginId !== null && page.next <= afterPluginId)
      )
        fail("installed_plugin_metadata_page_invalid");
      afterPluginId = page.next;
    }
    fail("installed_plugin_metadata_history_capacity_exceeded");
  }
  async #package(
    scope: PluginProfileScope,
    selection: PluginSelection,
  ): Promise<InstalledPluginPackage> {
    if (selection.selectedPackageDigest === null) denied();
    const saved = await this.#store.loadPackage({
      scope,
      packageDigest: selection.selectedPackageDigest,
    });
    if (saved === null) denied();
    const pkg = parseInstalledPluginPackage(saved);
    if (
      !same(scopeOf(pkg), scope) ||
      pkg.pluginId !== selection.pluginId ||
      pkg.publisherId !== selection.publisherId ||
      pkg.packageDigest !== selection.selectedPackageDigest
    )
      denied();
    return pkg;
  }
  async #unchanged(
    scope: PluginProfileScope,
    selection: PluginSelection,
    pkg: InstalledPluginPackage,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const selected = await this.#store.loadSelection({
      scope,
      pluginId: selection.pluginId,
    });
    signal.throwIfAborted();
    const saved = await this.#store.loadPackage({
      scope,
      packageDigest: pkg.packageDigest,
    });
    signal.throwIfAborted();
    if (!same(selected, selection) || !same(saved, pkg)) denied();
  }
  #operation<T>(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#pending.size >= 128)
      fail("installed_plugin_metadata_capacity_exceeded");
    const joined = AbortSignal.any([signal, this.#lifetime.signal]);
    joined.throwIfAborted();
    const physical = Promise.resolve().then(() => {
      joined.throwIfAborted();
      return work(joined);
    });
    this.#pending.add(physical);
    void physical.then(
      () => this.#pending.delete(physical),
      () => this.#pending.delete(physical),
    );
    return physical;
  }
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([...this.#pending]).then(
      () => {},
    ));
  }
}
function project(value: ExtensionRegistration): ExtensionRegistration {
  return Object.freeze({
    manifest: value.manifest,
    manifestDigest: value.manifestDigest,
    implementationDigest: value.implementationDigest,
  });
}
function scopeOf(value: PluginProfileScope): PluginProfileScope {
  return {
    tenantId: value.tenantId,
    spaceId: value.spaceId,
    profileId: value.profileId,
  };
}
function same(left: unknown, right: unknown) {
  return extensionCanonicalJson(left) === extensionCanonicalJson(right);
}
function fail(code: string): never {
  throw new ApplicationError("internal", code);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "installed_plugin_metadata_authority_denied",
  );
}
function ownValue(input: unknown, field: string): unknown {
  if (input === null || typeof input !== "object") denied();
  const descriptor = Object.getOwnPropertyDescriptor(input, field);
  if (!descriptor?.enumerable || !("value" in descriptor)) denied();
  return descriptor.value;
}
function version(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      input,
    ) ||
    input.length > 128
  )
    denied();
  return input;
}

function method<T extends object, K extends keyof T>(owner: T, key: K): T[K] {
  let current: object | null = owner;
  for (
    let depth = 0;
    current !== null && depth < 16;
    depth++, current = Object.getPrototypeOf(current)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value !== "function")
      denied();
    return descriptor.value.bind(owner) as T[K];
  }
  denied();
}
