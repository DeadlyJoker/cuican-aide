import { validateNativeOwnership } from "./desktop-native-ownership-check.ts";
import {
  ApplicationError,
  type ActorContext,
  type AuthorizationPort,
  type PluginInstallationHostProfilePort,
  type PluginUiAuthorizationPort,
  type PluginTaskUnmeteredAuthorityPort,
} from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parsePluginProfileScope,
  parsePluginTaskAdmissionPin,
  pluginInstallationDigest,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  assertDesktopPluginConfigurationRuntime,
  type DesktopPluginConfigurationRuntime,
} from "./desktop-plugin-configuration-runtime.ts";
import {
  assertDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import {
  assertDesktopPluginSourceRegistry,
  type DesktopPluginSourceRegistry,
} from "./desktop-plugin-source-registry.ts";
import {
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import { DesktopInstalledPluginActivationOwner } from "./desktop-installed-plugin-activation-owner.ts";
import {
  assertDesktopNativePluginControlComposition,
  assertDesktopNativePluginControlConfigCurrent,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
  pluginSecurityUiRequest,
} from "./plugin-security-validation.ts";
import type { InstalledPluginTaskActionOwnerDependencies } from "./installed-plugin-task-action-owner.ts";
import { composeDesktopNativeProjectMediaInputConfiguration } from "./desktop-native-project-media-input-composition.ts";
import type { InstalledProjectMediaInputConfiguration } from "./installed-project-media-input-configuration.ts";
import { composeDesktopNativeProjectMediaGenerationConfiguration } from "./desktop-native-project-media-generation-composition.ts";

export type DesktopNativePluginTaskBinding = Readonly<{
  configuration: DesktopPluginConfiguration;
  nativeControl: DesktopNativePluginControlConfig;
  activationOwner: DesktopInstalledPluginActivationOwner;
  installed: DesktopPluginConfigurationRuntime;
  registry: DesktopPluginSourceRegistry;
  authority: DesktopPluginAuthority;
  installation: DesktopPluginInstallationRuntime;
  store: SqliteRunStore;
}>;
const resourceFields = {
  "extension:read": ["kind", "tenantId", "spaceId", "pluginId"],
  "extension:run": ["kind", "tenantId", "spaceId", "pluginId"],
  "extension:query": ["kind", "tenantId", "spaceId", "pluginId"],
  "agentVersion:read": ["kind", "tenantId", "spaceId", "agentVersionId"],
  "thread:message:append": ["kind", "tenantId", "spaceId", "threadId"],
  "run:create": ["kind", "tenantId", "spaceId", "threadId", "runId"],
  "run:read": ["kind", "tenantId", "spaceId", "threadId", "runId"],
} as const;

/** Genuine local identity and installed state. It never creates an account, quote or paid admission. */
export class DesktopNativePluginTaskAuthority {
  readonly #binding: DesktopNativePluginTaskBinding;
  readonly #lifetime = new AbortController();
  readonly #physical = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  constructor(input: DesktopNativePluginTaskBinding) {
    assertDesktopNativePluginControlComposition(input);
    const configuration = parseDesktopPluginConfiguration(input.configuration);
    if (
      !(input.store instanceof SqliteRunStore) ||
      !(input.authority instanceof DesktopPluginAuthority) ||
      !(input.activationOwner instanceof DesktopInstalledPluginActivationOwner)
    )
      denied();
    assertDesktopPluginSourceRegistry(input.registry, configuration);
    assertDesktopPluginInstallationRuntime(input.installation, {
      ...input,
      configuration,
    });
    assertDesktopPluginConfigurationRuntime(input.installed, {
      ...input,
      configuration,
      activation: input.activationOwner,
    });
    input.activationOwner.assertTaskPeerBorrow({
      ...input,
      configuration,
      activation: input.nativeControl,
    });
    this.#binding = Object.freeze({ ...input, configuration });
    this.#owner(configuration.actor);
  }
  get requests() {
    return this.#binding.installed.requests;
  }
  /** Only the original file-declared metadata purpose uses these private request/commit checks. */
  projectMediaInputConfiguration():
    | InstalledProjectMediaInputConfiguration
    | undefined {
    return composeDesktopNativeProjectMediaInputConfiguration({
      configuration: this.#binding.configuration,
      nativeControl: this.#binding.nativeControl,
      assertRequestCurrent: (actor) => this.#request(actor),
      assertTransactionCurrent: (actor) => this.#commitOwner(actor),
    });
  }
  projectMediaGenerationConfiguration(
    dependencies: Pick<
      Parameters<
        typeof composeDesktopNativeProjectMediaGenerationConfiguration
      >[0],
      "configurations" | "storage" | "clock"
    >,
  ) {
    this.#owner(this.#binding.configuration.actor);
    return composeDesktopNativeProjectMediaGenerationConfiguration({
      ...dependencies,
      configuration: this.#binding.configuration,
      nativeControl: this.#binding.nativeControl,
      assertRequestCurrent: (actor) => this.#request(actor),
      assertTransactionCurrent: (actor) => this.#commitOwner(actor),
    });
  }
  readonly profiles: PluginInstallationHostProfilePort = Object.freeze({
    resolve: (actor: ActorContext) =>
      this.#operation(async () => {
        await this.#request(actor);
        return this.#binding.configuration.scope;
      }),
  });
  readonly businessAuthorization: AuthorizationPort = Object.freeze({
    authorize: (provided: Parameters<AuthorizationPort["authorize"]>[0]) =>
      this.#operation(async () => {
        const input = pluginSecurityRecord(provided, [
            "actor",
            "action",
            "resource",
          ]),
          actor = pluginSecurityActor(input.actor);
        await this.#request(actor);
        if (
          typeof input.action !== "string" ||
          !Object.hasOwn(resourceFields, input.action)
        )
          return {
            outcome: "deny" as const,
            reasonCode: "desktop_native_plugin_action_denied",
          };
        const action = input.action as keyof typeof resourceFields,
          resource = pluginSecurityRecord(
            input.resource,
            resourceFields[action],
          ),
          scope = this.#binding.configuration.scope;
        const kind = action.startsWith("extension:")
          ? "extension"
          : action.startsWith("run:")
            ? "run"
            : action === "agentVersion:read"
              ? "agentVersion"
              : "thread";
        if (
          resource.kind !== kind ||
          resource.tenantId !== scope.tenantId ||
          resource.spaceId !== scope.spaceId
        )
          denied();
        let allowed = false;
        if (kind === "extension")
          allowed = this.#binding.nativeControl.publication.entries.some(
            (entry) => entry.identity.pluginId === resource.pluginId,
          );
        else if (kind === "agentVersion")
          allowed = this.#binding.nativeControl.publication.entries.some(
            (entry) => entry.target.agentVersionId === resource.agentVersionId,
          );
        else if (kind === "thread" || action === "run:create") {
          if (typeof resource.threadId !== "string") denied();
          const thread = await this.#binding.store.loadThreadInSpace({
            ...scope,
            threadId: resource.threadId,
          });
          allowed =
            thread !== null && thread.createdByActorId === actor.actorId;
        } else if (action === "run:read") {
          if (
            typeof resource.runId !== "string" ||
            typeof resource.threadId !== "string"
          )
            denied();
          const run = await this.#binding.store.loadRunInSpace({
            ...scope,
            runId: resource.runId,
          });
          allowed =
            run !== null &&
            run.threadId === resource.threadId &&
            run.createdByActorId === actor.actorId;
        }
        await this.#request(actor);
        return allowed
          ? { outcome: "allow" as const }
          : {
              outcome: "deny" as const,
              reasonCode: "desktop_native_plugin_resource_denied",
            };
      }),
  });
  readonly uiAuthorization: PluginUiAuthorizationPort = Object.freeze({
    authorize: (
      provided: Parameters<PluginUiAuthorizationPort["authorize"]>[0],
    ) =>
      this.#operation(async () => {
        const request = pluginSecurityUiRequest(provided);
        this.#binding.authority.assertScope(request.actor, {
          tenantId: request.resource.tenantId,
          spaceId: request.resource.spaceId,
          profileId: request.resource.profileId,
        });
        if (
          request.resource.pluginId !== null &&
          !this.#binding.configuration.publications.some(
            (grant) =>
              grant.pluginId === request.resource.pluginId &&
              grant.packageDigest === request.resource.packageDigest,
          )
        )
          return {
            outcome: "deny" as const,
            reasonCode: "desktop_native_plugin_ui_unapproved",
          };
        this.#owner(request.actor);
        return {
          outcome: "allow" as const,
          authorityEpoch: this.#binding.configuration.authorityEpoch,
        };
      }),
  });
  readonly authorizePackage: InstalledPluginTaskActionOwnerDependencies["authorizePackage"] =
    (provided, signal) =>
      this.#operation(async () => {
        const value = pluginSecurityRecord(provided, [
            "actor",
            "scope",
            "candidate",
            "purpose",
          ]),
          actor = pluginSecurityActor(value.actor);
        await this.#request(actor);
        signal.throwIfAborted();
        this.#binding.authority.assertScope(
          actor,
          parsePluginProfileScope(value.scope),
        );
        if (value.purpose !== "read" && value.purpose !== "submit") denied();
        const candidate = pluginSecurityRecord(value.candidate, [
            "descriptor",
            "packageDigest",
          ]),
          actual = {
            descriptor: parsePluginPackageDescriptor(candidate.descriptor),
            packageDigest: pluginInstallationDigest(candidate.packageDigest),
          };
        const allowed =
          this.#binding.registry.authorizeCandidate(actual) === "allow" &&
          (value.purpose === "read" ||
            this.#binding.nativeControl.authority.packages.some(
              (pkg) =>
                pkg.pluginId === actual.descriptor.pluginId &&
                pkg.publisherId === actual.descriptor.publisherId &&
                pkg.version === actual.descriptor.version &&
                pkg.packageDigest === actual.packageDigest,
            ));
        await this.#request(actor);
        signal.throwIfAborted();
        return allowed ? "allow" : "deny";
      });
  readonly unmeteredTasks: PluginTaskUnmeteredAuthorityPort = Object.freeze({
    prepareGeneration: (
      provided: Parameters<
        PluginTaskUnmeteredAuthorityPort["prepareGeneration"]
      >[0],
    ) =>
      this.#operation(async () => {
        const value = pluginSecurityRecord(provided, ["actor", "pin"]),
          actor = pluginSecurityActor(value.actor),
          pin = parsePluginTaskAdmissionPin(value.pin);
        await this.#request(actor);
        const scope = this.#binding.configuration.scope;
        if (
          pin.tenantId !== scope.tenantId ||
          pin.spaceId !== scope.spaceId ||
          pin.profileId !== scope.profileId ||
          pin.principalId !== actor.principalId ||
          pin.actorId !== actor.actorId ||
          pin.authorityEpoch !== this.#binding.configuration.authorityEpoch ||
          !this.#binding.nativeControl.authority.packages.some(
            (pkg) =>
              pkg.pluginId === pin.pluginId &&
              pkg.publisherId === pin.publisherId &&
              pkg.version === pin.version &&
              pkg.packageDigest === pin.packageDigest,
          ) ||
          !this.#binding.configuration.publications.some(
            (grant) =>
              grant.pluginId === pin.pluginId &&
              grant.packageDigest === pin.packageDigest,
          )
        )
          denied();
        const assertActive = () => {
          this.#commitOwner(actor);
          const selection = this.#binding.store
            .pluginInstallationStore()
            .currentSelection({ scope, pluginId: pin.pluginId });
          if (
            selection === null ||
            selection.state !== "enabled" ||
            selection.revision !== pin.selectionRevision ||
            selection.selectedPackageDigest !== pin.packageDigest ||
            selection.publisherId !== pin.publisherId
          )
            denied();
        };
        assertActive();
        return Object.freeze({
          authorization: Object.freeze({
            authorityId: this.#binding.nativeControl.authority.authorityId,
            policyRevision: 1,
          }),
          assertActive,
          assertCurrent: async () => {
            assertActive();
            await this.requests.assertCurrent();
            assertActive();
          },
        });
      }),
  });
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }
  #owner(actor: ActorContext): void {
    validateNativeOwnership(() => {
      this.#lifetime.signal.throwIfAborted();
      assertDesktopNativePluginControlConfigCurrent(
        this.#binding.nativeControl,
      );
      this.#binding.authority.assertScope(
        pluginSecurityActor(actor),
        this.#binding.configuration.scope,
      );
      this.#binding.installation.assertProfileOwnership(actor);
      this.#binding.activationOwner.assertTaskPeerBorrow({
        ...this.#binding,
        activation: this.#binding.nativeControl,
      });
      assertDesktopPluginConfigurationRuntime(this.#binding.installed, {
        ...this.#binding,
        activation: this.#binding.activationOwner,
      });
      this.#lifetime.signal.throwIfAborted();
    });
  }
  #commitOwner(actor: ActorContext): void {
    validateNativeOwnership(() => {
      this.#lifetime.signal.throwIfAborted();
      assertDesktopNativePluginControlConfigCurrent(
        this.#binding.nativeControl,
      );
      this.#binding.authority.assertScope(
        actor,
        this.#binding.configuration.scope,
      );
      this.#binding.installation.assertProfileOwnershipForSelectionCommit(
        actor,
      );
      this.requests.currentSignal().throwIfAborted();
      if (
        !same(this.requests.currentActor(), actor) ||
        !same(this.requests.currentScope(), this.#binding.configuration.scope)
      )
        denied();
    });
  }
  async #request(actor: ActorContext): Promise<void> {
    this.#lifetime.signal.throwIfAborted();
    if (
      !same(this.requests.currentActor(), actor) ||
      !same(this.requests.currentScope(), this.#binding.configuration.scope)
    )
      denied();
    await this.requests.assertCurrent();
    // The original request owner authenticates and resolves the live profile.
    // Validate every borrowed owner after that await, before granting anything.
    this.#owner(actor);
  }
  #operation<T>(work: () => Promise<T>): Promise<T> {
    // Each operation checks its owner before returning a decision or receipt.
    // Scheduling bounded work does not itself grant access.
    this.#lifetime.signal.throwIfAborted();
    if (this.#physical.size >= 128) denied();
    const pending = Promise.resolve().then(work);
    this.#physical.add(pending);
    void pending.finally(() => this.#physical.delete(pending)).catch(() => {});
    return pending;
  }
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_native_plugin_task_authority_unavailable",
  );
}
