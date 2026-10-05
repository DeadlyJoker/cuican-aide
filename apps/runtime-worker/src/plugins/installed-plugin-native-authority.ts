import { isDeepStrictEqual } from "node:util";
import type {
  ActorContext,
  AuthorizationPort,
  CreativeProjectAuthorizationPort,
} from "@crewon/application";
import {
  parseDesktopProjectHistoryConfiguration,
  type DesktopProjectHistoryConfiguration,
} from "@crewon/contracts";
import {
  parseDesktopProjectExecutionConfiguration,
  type DesktopProjectExecutionConfiguration,
} from "@crewon/contracts/plugins";
import type { DesktopNativePluginPackageIdentity } from "@crewon/contracts/plugins";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginProfileScope,
  parsePluginTaskAdmission,
  parsePluginQueryTaskAdmission,
  effectivePluginQueryTaskAdmission,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type PluginProfileScope,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import {
  assertInstalledPluginNativeWorkerConfig,
  type InstalledPluginNativeWorkerConfig,
} from "./installed-plugin-authority-config.ts";
import {
  captureNativeAuthorityFile,
  captureNativePluginAuthority,
  nativeAuthorityFailure as fail,
} from "./installed-plugin-native-authority-files.ts";
import {
  captureNetworkApproval,
  ioJson,
  ioRecord,
} from "./plugin-execution-io-network.ts";
import { snapshotContext } from "./plugin-tool-runtime-adapter-data.ts";
import {
  installedPluginReleaseDigester,
  parseInstalledPluginReleaseDocument,
  type InstalledPluginReleaseDocument,
  type InstalledPluginReleaseIdentity,
} from "./installed-plugin-release-document.ts";
import type { InstalledPluginExecutionReadinessMetadata } from "./installed-plugin-execution-readiness-types.ts";
import { createNativeProjectPlanningRuntime } from "./native-project-planning-runtime.ts";
import type {
  InstalledPluginWorkerAuthority,
  InstalledPluginReadAuthorityInput,
} from "./installed-plugin-worker-authority.ts";

type Purpose = "read" | "submit" | "observe";
const digester = installedPluginReleaseDigester;
function tuple(
  input: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
  }>,
): DesktopNativePluginPackageIdentity {
  return {
    pluginId: input.pluginId,
    publisherId: input.publisherId,
    version: input.version,
    packageDigest: input.packageDigest,
  };
}
/** Actual Native policy and existing SQLite records, independent of remote deployment authorities. */
class NativeAuthorityOwner {
  readonly config: InstalledPluginNativeWorkerConfig;
  readonly files: ReturnType<typeof captureNativePluginAuthority>;
  readonly store: SqliteRunStore;
  readonly projects:
    | DesktopProjectHistoryConfiguration
    | DesktopProjectExecutionConfiguration
    | undefined;
  readonly #physical = new Set<Promise<unknown>>();
  #release: Readonly<{
    document: InstalledPluginReleaseDocument;
    assertCurrent(): void;
  }> | null = null;
  #closed = false;
  #closing: Promise<void> | null = null;
  constructor(config: InstalledPluginNativeWorkerConfig) {
    assertInstalledPluginNativeWorkerConfig(config);
    this.config = config;
    this.files = captureNativePluginAuthority(config.nativeAuthorityPath);
    const bootstrap = captureNativeAuthorityFile(
      this.files.authority.bootstrapPath,
      1024 * 1024,
    ).value as Record<string, unknown>;
    // UI publication approval and Node execution approval are separate. The
    // pinned Main bootstrap supplies the former, including UI-only packages.
    const projectOptions = {
      publications: bootstrap.publications as readonly Readonly<{
        pluginId: string;
        packageDigest: string;
      }>[],
    };
    switch (bootstrap.schemaVersion) {
      case "crewon.desktop-plugin-bootstrap.v1":
        if (bootstrap.projects !== undefined)
          fail("project_configuration_binding_invalid");
        this.projects = undefined;
        break;
      case "crewon.desktop-plugin-bootstrap.v2":
        this.projects = parseDesktopProjectHistoryConfiguration(
          bootstrap.projects,
          projectOptions,
        );
        break;
      case "crewon.desktop-plugin-bootstrap.v3":
        this.projects = parseDesktopProjectExecutionConfiguration(
          bootstrap.projects,
          projectOptions,
        );
        break;
      default:
        fail("project_configuration_binding_invalid");
    }
    if (
      config.installRoot !== this.files.authority.installRoot ||
      (config.historicalScope !== null &&
        !isDeepStrictEqual(config.historicalScope, this.files.authority.scope))
    )
      fail("configuration_binding_invalid");
    this.files.assertCurrent();
    this.store = new SqliteRunStore(this.files.authority.controlDatabasePath);
    try {
      this.current();
    } catch (error) {
      void this.store.close();
      throw error;
    }
  }
  current(signal?: AbortSignal): void {
    if (this.#closed) fail("closed");
    signal?.throwIfAborted();
    assertInstalledPluginNativeWorkerConfig(this.config);
    this.files.assertCurrent();
    this.#release?.assertCurrent();
  }
  operate<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.current(signal);
    if (this.#physical.size >= 128) fail("busy");
    const pending = Promise.resolve().then(async () => {
      this.current(signal);
      const result = await work();
      this.current(signal);
      return result;
    });
    this.#physical.add(pending);
    void pending.finally(() => this.#physical.delete(pending)).catch(() => {});
    return pending;
  }
  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(() =>
      this.store.close(),
    ));
  }
  actor(input: unknown): ActorContext {
    const value = ioRecord(input, [
      "principalId",
      "actorId",
      "tenantId",
      "spaceId",
    ]);
    if (!isDeepStrictEqual(value, this.files.authority.actor))
      fail("owner_mismatch");
    return this.files.authority.actor;
  }
  projectPolicy: CreativeProjectAuthorizationPort["authorize"] = async (
    provided,
  ) => {
    this.current();
    const input = ioRecord(ioJson(provided, 16 * 1024), [
      "actor",
      "action",
      "resource",
    ]);
    this.actor(input.actor);
    const r = ioRecord(input.resource, [
        "kind",
        "tenantId",
        "spaceId",
        "projectId",
      ]),
      actor = this.files.authority.actor;
    if (
      r.kind !== "creativeProject" ||
      r.tenantId !== actor.tenantId ||
      r.spaceId !== actor.spaceId ||
      ![
        "creativeProject:create",
        "creativeProject:list",
        "creativeProject:read",
        "creativeProject:write",
      ].includes(input.action as string) ||
      this.projects?.conversations === undefined
    )
      return { outcome: "deny", reasonCode: "native_project_policy_denied" };
    if (r.projectId === null)
      return input.action === "creativeProject:create" ||
        input.action === "creativeProject:list"
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "native_project_policy_denied" };
    if (typeof r.projectId !== "string")
      return { outcome: "deny", reasonCode: "native_project_policy_denied" };
    // Project ownership/current state are checked by the real Application/Store on its
    // existing connection. This independent approval PDP must not borrow it inside COMMIT.
    this.current();
    return { outcome: "allow" };
  };
  scope(input: unknown): PluginProfileScope {
    const scope = parsePluginProfileScope(input);
    if (!isDeepStrictEqual(scope, this.files.authority.scope))
      fail("profile_mismatch");
    return scope;
  }
  release(): InstalledPluginReleaseDocument {
    this.current();
    if (this.#release === null) {
      const file = captureNativeAuthorityFile(
          this.config.releaseDocumentPath,
          1024 * 1024,
        ),
        document = parseInstalledPluginReleaseDocument(file.value);
      if (
        document.tenantId !== this.files.authority.scope.tenantId ||
        document.entries.some(
          (entry) =>
            !isDeepStrictEqual(entry.scope, this.files.authority.scope) ||
            !this.files.authority.packages.some((pkg) =>
              isDeepStrictEqual(pkg, entry.packageIdentity),
            ),
        )
      )
        fail("release_binding_invalid");
      this.#release = Object.freeze({
        document,
        assertCurrent: file.assertCurrent,
      });
    }
    this.#release.assertCurrent();
    return this.#release.document;
  }
  async package(
    identity: InstalledPluginReleaseIdentity,
    purpose: Purpose,
  ): Promise<boolean> {
    this.current();
    const checked = ioRecord(ioJson(identity, 16 * 1024), [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
    ]);
    const expected = tuple(checked as InstalledPluginReleaseIdentity),
      authority = this.files.authority;
    if (
      !authority.packages.some((approved) =>
        isDeepStrictEqual(approved, expected),
      )
    )
      return false;
    const pkg = await this.store.pluginInstallationStore().loadPackage({
      scope: authority.scope,
      packageDigest: expected.packageDigest,
    });
    this.current();
    if (
      pkg === null ||
      !isDeepStrictEqual(tuple(pkg), expected) ||
      !isDeepStrictEqual(
        {
          tenantId: pkg.tenantId,
          spaceId: pkg.spaceId,
          profileId: pkg.profileId,
        },
        authority.scope,
      )
    )
      return false;
    if (purpose === "submit") {
      const selection = await this.store
        .pluginInstallationStore()
        .loadSelection({ scope: authority.scope, pluginId: expected.pluginId });
      this.current();
      if (
        selection === null ||
        selection.state !== "enabled" ||
        selection.selectedPackageDigest !== expected.packageDigest ||
        selection.publisherId !== expected.publisherId
      )
        return false;
    }
    return true;
  }
  async candidatePackage(
    identity: InstalledPluginReleaseIdentity,
    expectedSelectionRevision: number,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(expectedSelectionRevision) ||
      expectedSelectionRevision < 1
    )
      fail("selection_revision_invalid");
    if (!(await this.package(identity, "read"))) return false;
    const selection = await this.store.pluginInstallationStore().loadSelection({
      scope: this.files.authority.scope,
      pluginId: identity.pluginId,
    });
    this.current();
    return (
      selection !== null &&
      selection.state === "disabled" &&
      selection.revision === expectedSelectionRevision &&
      selection.selectedPackageDigest === identity.packageDigest &&
      selection.publisherId === identity.publisherId
    );
  }
  async target(
    identity: InstalledPluginReleaseIdentity,
    configuration: ExtensionConfiguration,
    target: ExtensionExecutionTarget,
    purpose: "submit" | "observe",
  ): Promise<boolean> {
    if (!(await this.package(identity, purpose))) return false;
    const scope = this.files.authority.scope;
    const saved = await this.store.extensionStore().loadExtensionConfiguration({
      ...scope,
      pluginId: identity.pluginId,
      revision: configuration.revision,
    });
    this.current();
    if (saved === null || !isDeepStrictEqual(saved, configuration))
      return false;
    if (purpose === "submit") {
      const latest = await this.store
        .extensionStore()
        .loadLatestExtensionConfiguration({
          ...scope,
          pluginId: identity.pluginId,
        });
      this.current();
      if (!isDeepStrictEqual(latest, configuration)) return false;
    }
    const entry = this.release().entries.find(
      (entry) =>
        isDeepStrictEqual(entry.packageIdentity, tuple(identity)) &&
        isDeepStrictEqual(entry.configuration, configuration) &&
        isDeepStrictEqual(entry.target, target),
    );
    if (!entry || target.executionAuthority !== "crewonKernel") return false;
    const deployment = await this.store.loadAgentVersionDeployment({
      tenantId: scope.tenantId,
      agentVersionId: target.agentVersionId,
    });
    this.current();
    return (
      deployment !== null &&
      deployment.tenantId === scope.tenantId &&
      deployment.agentVersionId === target.agentVersionId &&
      deployment.contentDigest === target.agentVersionContentDigest &&
      deployment.materializationDigest === target.materializationDigest &&
      deployment.authorityId === target.authorityId &&
      deployment.workspaceBindingId === target.workspaceBindingId
    );
  }
  async network(
    metadata: InstalledPluginExecutionReadinessMetadata,
    enforceEnabled: boolean,
  ) {
    this.scope(metadata.scope);
    const configuration = parseExtensionConfiguration(
        metadata.configuration,
        digester,
      ),
      target = parseExtensionExecutionTarget(metadata.target);
    if (
      (metadata.purpose !== "submit" && metadata.purpose !== "observe") ||
      configuration.pluginId !== metadata.identity.pluginId ||
      configuration.pluginVersion !== metadata.identity.version
    )
      fail("network_metadata_invalid");
    // Candidate readiness precedes enabling. It still requires a genuine installed package and published exact target.
    if (
      !(await this.target(
        metadata.identity,
        configuration,
        target,
        enforceEnabled ? metadata.purpose : "observe",
      ))
    )
      return null;
    const grant = this.files.authority.networkGrants.find(
      (grant) =>
        isDeepStrictEqual(tuple(grant), tuple(metadata.identity)) &&
        configuration.parameters[grant.baseUrlParameter] === grant.baseUrl,
    );
    return grant === undefined
      ? null
      : captureNetworkApproval({
          baseUrlParameter: grant.baseUrlParameter,
          paths: grant.paths,
        });
  }
  async admission(
    locator: Readonly<{ tenantId: string; spaceId: string; runId: string }>,
  ) {
    const extensions = this.store.extensionStore();
    const admission = await extensions.loadPluginTaskAdmission(locator);
    const query = await extensions.loadPluginQueryTaskAdmission(locator);
    this.current();
    if (admission !== null && query !== null) fail("admission_conflict");
    return query !== null
      ? effectivePluginQueryTaskAdmission(parsePluginQueryTaskAdmission(query))
      : admission === null
        ? null
        : parsePluginTaskAdmission(admission);
  }
  async policy(provided: Parameters<AuthorizationPort["authorize"]>[0]) {
    const request = ioRecord(ioJson(provided, 128 * 1024), [
      "actor",
      "action",
      "resource",
    ]);
    this.actor(request.actor);
    const resource = ioRecord(
      request.resource,
      ["kind", "tenantId", "spaceId"],
      ["pluginId", "agentVersionId", "threadId", "runId"],
    );
    const scope = this.files.authority.scope;
    if (
      resource.tenantId !== scope.tenantId ||
      resource.spaceId !== scope.spaceId
    )
      fail("scope_mismatch");
    let allowed = false;
    switch (request.action) {
      case "extension:read":
      case "extension:query":
      case "extension:run": {
        ioRecord(resource, ["kind", "tenantId", "spaceId", "pluginId"]);
        if (resource.kind !== "extension") break;
        const approved = this.files.authority.packages.filter(
          (pkg) => pkg.pluginId === resource.pluginId,
        );
        for (const pkg of approved)
          if (
            await this.package(
              pkg,
              request.action === "extension:run" ? "submit" : "read",
            )
          ) {
            allowed = true;
            break;
          }
        break;
      }
      case "run:read":
      case "run:execute": {
        ioRecord(resource, [
          "kind",
          "tenantId",
          "spaceId",
          "threadId",
          "runId",
        ]);
        if (
          resource.kind !== "run" ||
          typeof resource.runId !== "string" ||
          typeof resource.threadId !== "string"
        )
          break;
        const locator = {
          tenantId: scope.tenantId,
          spaceId: scope.spaceId,
          runId: resource.runId,
        };
        const run = await this.store.loadRunInSpace(locator),
          admission = await this.admission(locator);
        this.current();
        if (run && admission) {
          const parsed = admission;
          allowed =
            run.threadId === resource.threadId &&
            run.createdByActorId === this.files.authority.actor.actorId &&
            parsed.actorId === this.files.authority.actor.actorId &&
            parsed.principalId === this.files.authority.actor.principalId &&
            parsed.profileId === scope.profileId &&
            this.files.authority.packages.some((pkg) =>
              isDeepStrictEqual(pkg, tuple(parsed)),
            );
        }
        break;
      }
      case "agentVersion:read": {
        ioRecord(resource, ["kind", "tenantId", "spaceId", "agentVersionId"]);
        if (
          resource.kind !== "agentVersion" ||
          typeof resource.agentVersionId !== "string"
        )
          break;
        const document = this.release();
        allowed =
          document.defaultAgentVersionId === resource.agentVersionId ||
          document.entries.some(
            (entry) =>
              entry.version.agentVersionId === resource.agentVersionId ||
              entry.modelSource.version.agentVersionId ===
                resource.agentVersionId,
          );
        if (allowed)
          allowed =
            (await this.store.loadAgentVersion({
              tenantId: scope.tenantId,
              agentVersionId: resource.agentVersionId,
            })) !== null;
        break;
      }
    }
    return allowed
      ? { outcome: "allow" as const }
      : {
          outcome: "deny" as const,
          reasonCode: "desktop_native_plugin_policy_denied",
        };
  }
  async runNetwork(provided: PluginToolRuntimeContext, signal: AbortSignal) {
    const context = snapshotContext(provided),
      scope = this.scope(context.scope);
    const locator = {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      runId: context.run.runId,
    };
    const binding = await this.store
        .extensionStore()
        .loadExtensionRunBinding(locator),
      admission = await this.admission(locator),
      run = await this.store.loadRunInSpace(locator);
    this.current(signal);
    if (
      !binding ||
      !admission ||
      !run ||
      run.createdByActorId !== this.files.authority.actor.actorId ||
      run.threadId !== context.run.threadId ||
      binding.threadId !== context.run.threadId ||
      binding.bindingDigest !== context.run.bindingDigest ||
      binding.inputDigest !== context.run.inputDigest ||
      binding.pluginId !== context.identity.pluginId ||
      !isDeepStrictEqual(binding.source, context.run.source) ||
      !isDeepStrictEqual(binding.target, context.target)
    )
      return null;
    const pin = admission;
    if (
      pin.principalId !== this.files.authority.actor.principalId ||
      pin.actorId !== this.files.authority.actor.actorId ||
      pin.profileId !== scope.profileId ||
      !isDeepStrictEqual(
        {
          pluginId: pin.pluginId,
          version: pin.version,
          packageDigest: pin.packageDigest,
        },
        context.identity,
      )
    )
      return null;
    const configuration = await this.store
      .extensionStore()
      .loadExtensionConfiguration({
        ...scope,
        pluginId: pin.pluginId,
        revision: context.configuration.revision,
      });
    this.current(signal);
    if (
      !configuration ||
      !isDeepStrictEqual(
        {
          revision: configuration.revision,
          contentDigest: configuration.contentDigest,
          parameters: configuration.parameters,
          credentialBindings: configuration.credentialBindings,
        },
        context.configuration,
      )
    )
      return null;
    return this.network(
      {
        identity: tuple(pin),
        scope,
        configuration,
        target: parseExtensionExecutionTarget(context.target),
        purpose: context.run.source === null ? "submit" : "observe",
      },
      true,
    );
  }
}

export function createInstalledPluginNativeWorkerAuthority(
  config: InstalledPluginNativeWorkerConfig,
): InstalledPluginWorkerAuthority {
  const owner = new NativeAuthorityOwner(config);
  const authorizeRead = (
    input: InstalledPluginReadAuthorityInput,
    signal: AbortSignal,
  ) =>
    owner.operate(async () => {
      const value = ioRecord(input, ["identity", "scope", "purpose"]);
      owner.scope(value.scope);
      if (value.purpose !== "read") fail("purpose_invalid");
      return (await owner.package(
        value.identity as InstalledPluginReleaseIdentity,
        "read",
      ))
        ? ("allow" as const)
        : ("deny" as const);
    }, signal);
  const resolveProfile = (actor: ActorContext, signal: AbortSignal) =>
    owner.operate(async () => {
      owner.actor(actor);
      return owner.files.authority.scope;
    }, signal);
  return Object.freeze({
    installRoot: config.installRoot,
    releaseDocumentPath: config.releaseDocumentPath,
    authorizeRead,
    resolveProfile,
    ...(owner.projects?.planningDrafts === undefined
      ? {}
      : {
          projectPlanning: createNativeProjectPlanningRuntime({
            actor: owner.files.authority.actor,
            scope: owner.files.authority.scope,
            projects: owner.projects,
            installRoot: config.installRoot,
            store: owner.store,
            current: owner.current.bind(owner),
            operate: owner.operate.bind(owner),
            release: owner.release.bind(owner),
            target: owner.target.bind(owner),
          }),
        }),
    installedPluginExecution: Object.freeze({
      installRoot: config.installRoot,
      ...(owner.projects?.conversations === undefined
        ? {}
        : {
            projectTools: Object.freeze({
              version: "crewon.project-tools.v1" as const,
              authorization: Object.freeze({
                authorize: (
                  input: Parameters<
                    CreativeProjectAuthorizationPort["authorize"]
                  >[0],
                ) => owner.operate(() => owner.projectPolicy(input)),
              }),
              authorizeService: (
                admission: import("@crewon/domain").PluginTaskAdmission,
                signal: AbortSignal,
              ) =>
                owner.operate(async () => {
                  owner.current(signal);
                  owner.actor({
                    tenantId: admission.tenantId,
                    spaceId: admission.spaceId,
                    principalId: admission.principalId,
                    actorId: admission.actorId,
                  });
                  if (
                    !owner.projects!.conversations!.publications.some(
                      (p) =>
                        p.pluginId === admission.pluginId &&
                        p.packageDigest === admission.packageDigest &&
                        p.contributionId === admission.contributionId,
                    )
                  )
                    fail("project_service_unapproved");
                }, signal),
            }),
          }),
      authorization: Object.freeze({
        authorize: (input: Parameters<AuthorizationPort["authorize"]>[0]) =>
          owner.operate(() => owner.policy(input)),
      }),
      resolveActor: (
        input: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
        signal: AbortSignal,
      ) =>
        owner.operate(async () => {
          const value = ioRecord(input, ["tenantId", "spaceId", "actorId"]),
            actor = owner.files.authority.actor;
          return Object.entries(value).every(
            ([field, expected]) =>
              actor[field as keyof ActorContext] === expected,
          )
            ? actor
            : null;
        }, signal),
      authorizePackage: (
        input: Readonly<{
          candidate: Readonly<{ descriptor: unknown; packageDigest: string }>;
          scope: PluginProfileScope;
          purpose: "submit" | "observe";
        }>,
        signal: AbortSignal,
      ) =>
        owner.operate(async () => {
          const value = ioRecord(input, ["candidate", "scope", "purpose"]);
          owner.scope(value.scope);
          if (value.purpose !== "submit" && value.purpose !== "observe")
            fail("purpose_invalid");
          const candidate = ioRecord(ioJson(value.candidate, 128 * 1024), [
              "descriptor",
              "packageDigest",
            ]),
            descriptor = parsePluginPackageDescriptor(candidate.descriptor);
          return (await owner.package(
            {
              pluginId: descriptor.pluginId,
              publisherId: descriptor.publisherId,
              version: descriptor.version,
              packageDigest: candidate.packageDigest as string,
            },
            value.purpose,
          ))
            ? ("allow" as const)
            : ("deny" as const);
        }, signal),
      authorizeCandidatePackage: (
        input: Readonly<{
          candidate: Readonly<{ descriptor: unknown; packageDigest: string }>;
          scope: PluginProfileScope;
          expectedSelectionRevision: number;
        }>,
        signal: AbortSignal,
      ) =>
        owner.operate(async () => {
          const value = ioRecord(input, [
            "candidate",
            "scope",
            "expectedSelectionRevision",
          ]);
          owner.scope(value.scope);
          const candidate = ioRecord(ioJson(value.candidate, 128 * 1024), [
              "descriptor",
              "packageDigest",
            ]),
            descriptor = parsePluginPackageDescriptor(candidate.descriptor);
          return (await owner.candidatePackage(
            {
              pluginId: descriptor.pluginId,
              publisherId: descriptor.publisherId,
              version: descriptor.version,
              packageDigest: candidate.packageDigest as string,
            },
            value.expectedSelectionRevision as number,
          ))
            ? ("allow" as const)
            : ("deny" as const);
        }, signal),
      executionIo: Object.freeze({
        resolveNetwork: (
          context: PluginToolRuntimeContext,
          signal: AbortSignal,
        ) => owner.operate(() => owner.runNetwork(context, signal), signal),
        resolveReadinessNetwork: (
          metadata: InstalledPluginExecutionReadinessMetadata,
          signal: AbortSignal,
        ) =>
          owner.operate(
            () =>
              owner.network(
                ioRecord(ioJson(metadata, 128 * 1024), [
                  "identity",
                  "scope",
                  "configuration",
                  "target",
                  "purpose",
                ]) as unknown as InstalledPluginExecutionReadinessMetadata,
                false,
              ),
            signal,
          ),
      }),
      ...(config.historicalScope === null
        ? {}
        : {
            historicalQuery: Object.freeze({
              scope: config.historicalScope,
              resolveProfile,
            }),
          }),
    }),
    close: () => owner.close(),
  });
}
