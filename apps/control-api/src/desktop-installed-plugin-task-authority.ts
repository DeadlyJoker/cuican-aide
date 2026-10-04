import {
  ApplicationError,
  type ActorContext,
  type AuthorizationPort,
  type ContentDigester,
  type ExtensionCreditQuotePort,
  type PluginInstallationHostProfilePort,
  type PluginUiAuthorizationPort,
} from "@crewon/application";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parsePluginProfileScope,
  pluginInstallationDigest,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  assertDesktopPluginConfigurationFileCurrent,
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
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
import { DesktopInstalledPluginActivationOwner } from "./desktop-installed-plugin-activation-owner.ts";
import {
  assertDesktopInstalledPluginActivationConfigCurrent,
  type DesktopInstalledPluginActivationConfig,
} from "./desktop-installed-plugin-activation-environment.ts";
import {
  assertDesktopInstalledPluginTaskConfigCurrent,
  type DesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import {
  InstalledPluginCreditQuoteAuthority,
  InstalledPluginTaskHttpAuthority,
} from "./installed-plugin-credit-quote-authority.ts";
import type { InstalledPluginTaskActionOwnerDependencies } from "./installed-plugin-task-action-owner.ts";
import {
  pluginSecurityActor,
  pluginSecurityInstallationDecision,
  pluginSecurityRecord,
  pluginSecurityUiDecision,
  pluginSecurityUiRequest,
} from "./plugin-security-validation.ts";

type Binding = Readonly<{
  configuration: DesktopPluginConfiguration;
  tasks: DesktopInstalledPluginTaskConfig;
  activation: DesktopInstalledPluginActivationConfig;
  activationOwner: DesktopInstalledPluginActivationOwner;
  installed: DesktopPluginConfigurationRuntime;
  registry: DesktopPluginSourceRegistry;
  authority: DesktopPluginAuthority;
  installation: DesktopPluginInstallationRuntime;
  store: SqliteRunStore;
}>;
const issued = new WeakSet<object>();
const resourceFields = {
  "extension:read": ["kind", "tenantId", "spaceId", "pluginId"],
  "extension:run": ["kind", "tenantId", "spaceId", "pluginId"],
  "extension:query": ["kind", "tenantId", "spaceId", "pluginId"],
  "agentVersion:read": ["kind", "tenantId", "spaceId", "agentVersionId"],
  "thread:message:append": ["kind", "tenantId", "spaceId", "threadId"],
  "run:create": ["kind", "tenantId", "spaceId", "threadId", "runId"],
  "run:read": ["kind", "tenantId", "spaceId", "threadId", "runId"],
} as const;

/** Independent Native task policies and exact quotes. Borrows the already issued request/activation peer; never activates or funds. */
export class DesktopInstalledPluginTaskAuthority {
  readonly #binding: Binding;
  readonly #fileConfiguration: DesktopPluginConfiguration | undefined;
  readonly #digester: ContentDigester;
  readonly #http: InstalledPluginTaskHttpAuthority;
  readonly #quote: InstalledPluginCreditQuoteAuthority;
  readonly #publicationDigest: string;
  readonly #lifetime = new AbortController();
  readonly #physical = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;

  constructor(
    input: Binding,
    dependencies: Readonly<{
      digester: ContentDigester;
      fetch?: typeof globalThis.fetch;
    }>,
  ) {
    const configuration = parseDesktopPluginConfiguration(input.configuration);
    this.#fileConfiguration =
      configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
        ? input.configuration
        : undefined;
    if (this.#fileConfiguration !== undefined)
      assertDesktopPluginConfigurationFileCurrent(this.#fileConfiguration);
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
    input.activationOwner.assertTaskPeerBorrow({ ...input, configuration });
    assertDesktopInstalledPluginActivationConfigCurrent(input.activation);
    assertDesktopInstalledPluginTaskConfigCurrent(input.tasks);
    this.#digester = Object.freeze({
      sha256: dependencies.digester.sha256.bind(dependencies.digester),
    });
    const publication = input.tasks.publication;
    if (
      !same(publication.actor, configuration.actor) ||
      !same(publication.scope, configuration.scope) ||
      publication.installRoot !== configuration.installRoot ||
      publication.authorityEpoch !== configuration.authorityEpoch ||
      publication.activationDigest !==
        this.#digester.sha256(
          extensionCanonicalJson(input.activation.publication),
        ) ||
      publication.uiPublications.some(
        (grant) =>
          !configuration.publications.some(
            (approved) =>
              approved.pluginId === grant.pluginId &&
              approved.packageDigest === grant.packageDigest,
          ),
      )
    )
      denied();
    this.#binding = Object.freeze({ ...input, configuration });
    this.#publicationDigest = this.#digester.sha256(
      extensionCanonicalJson(publication),
    );
    this.#assertOwner(configuration.actor);
    this.#http = new InstalledPluginTaskHttpAuthority({
      timeoutMs: publication.timeoutMs,
      fetch: dependencies.fetch,
    });
    this.#quote = new InstalledPluginCreditQuoteAuthority({
      endpoint: {
        url: publication.quoteAuthority.url,
        serviceToken: input.tasks.quoteToken,
      },
      http: this.#http,
      digester: this.#digester,
      currentSignal: () => this.#requestSignal(),
      assertCurrent: () => this.#assertRequest(),
    });
    issued.add(this);
  }

  assertBinding(input: Binding): void {
    if (
      !issued.has(this) ||
      (this.#fileConfiguration !== undefined &&
        input.configuration !== this.#fileConfiguration) ||
      input.tasks !== this.#binding.tasks ||
      input.activation !== this.#binding.activation ||
      input.activationOwner !== this.#binding.activationOwner ||
      input.installed !== this.#binding.installed ||
      input.registry !== this.#binding.registry ||
      input.authority !== this.#binding.authority ||
      input.installation !== this.#binding.installation ||
      input.store !== this.#binding.store ||
      !same(
        parseDesktopPluginConfiguration(input.configuration),
        this.#binding.configuration,
      )
    )
      denied();
    this.#assertOwner(this.#binding.configuration.actor);
  }

  get requests() {
    return this.#binding.installed.requests;
  }
  readonly profiles: PluginInstallationHostProfilePort = Object.freeze({
    resolve: (actor: ActorContext) =>
      this.#operation(async () => {
        await this.#assertRequest(actor);
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
        ]);
        const actor = pluginSecurityActor(input.actor);
        await this.#assertRequest(actor);
        if (
          typeof input.action !== "string" ||
          !Object.hasOwn(resourceFields, input.action)
        )
          return {
            outcome: "deny" as const,
            reasonCode: "desktop_plugin_task_action_denied",
          };
        const action = input.action as keyof typeof resourceFields;
        const resource = pluginSecurityRecord(
          parsePluginUiJsonValue(input.resource),
          resourceFields[action],
        );
        const kind = action.startsWith("extension:")
          ? "extension"
          : action.startsWith("run:")
            ? "run"
            : action === "agentVersion:read"
              ? "agentVersion"
              : "thread";
        if (
          resource.kind !== kind ||
          resource.tenantId !== actor.tenantId ||
          resource.spaceId !== actor.spaceId ||
          (kind === "extension" &&
            !this.#binding.configuration.sources.some(
              (source) => source.pluginId === resource.pluginId,
            ))
        )
          denied();
        const response = await this.#http.post(
          {
            url: this.#binding.tasks.publication.taskPolicyAuthority.url,
            serviceToken: this.#binding.tasks.taskPolicyToken,
          },
          { actor, action, resource },
          this.#requestSignal(),
        );
        await this.#assertRequest(actor);
        return pluginSecurityInstallationDecision(response);
      }),
  });
  /** The Native Application and all task owners must share this exact port for these source grants. */
  readonly uiAuthorization: PluginUiAuthorizationPort = Object.freeze({
    authorize: (
      provided: Parameters<PluginUiAuthorizationPort["authorize"]>[0],
    ) =>
      this.#operation(async () => {
        const request = pluginSecurityUiRequest(provided);
        this.#assertOwner(request.actor);
        const resource = request.resource;
        this.#binding.authority.assertScope(request.actor, {
          tenantId: resource.tenantId,
          spaceId: resource.spaceId,
          profileId: resource.profileId,
        });
        const scopeCatalog =
          request.action === "catalog" &&
          resource.pluginId === null &&
          resource.packageDigest === null &&
          resource.contributionId === null &&
          resource.selectionRevision === null;
        if (
          !scopeCatalog &&
          !this.#binding.tasks.publication.uiPublications.some(
            (grant) =>
              grant.pluginId === resource.pluginId &&
              grant.packageDigest === resource.packageDigest &&
              (grant.contributionId === resource.contributionId ||
                (request.action === "catalog" &&
                  resource.contributionId === null)),
          )
        )
          return {
            outcome: "deny" as const,
            reasonCode: "desktop_plugin_task_ui_unapproved",
          };
        const response = await this.#http.post(
          {
            url: this.#binding.tasks.publication.uiPolicyAuthority.url,
            serviceToken: this.#binding.tasks.uiPolicyToken,
          },
          { ...request, action: `pluginUi:${request.action}` },
          this.#lifetime.signal,
        );
        this.#assertOwner(request.actor);
        const decision = pluginSecurityUiDecision(response);
        if (decision.outcome === "deny") return decision;
        // A remote permission epoch cannot erase the Native bootstrap/file and activation binding.
        return {
          outcome: "allow" as const,
          authorityEpoch: this.#digester
            .sha256(
              extensionCanonicalJson({
                nativeEpoch: this.#binding.configuration.authorityEpoch,
                publicationDigest: this.#publicationDigest,
                policyEpoch: decision.authorityEpoch,
              }),
            )
            .slice(7),
        };
      }),
  });
  readonly authorizePackage: InstalledPluginTaskActionOwnerDependencies["authorizePackage"] =
    (provided, signal) =>
      this.#operation(async () => {
        const input = pluginSecurityRecord(provided, [
          "actor",
          "scope",
          "candidate",
          "purpose",
        ]);
        const actor = pluginSecurityActor(input.actor);
        await this.#assertRequest(actor);
        const scope = parsePluginProfileScope(input.scope);
        this.#binding.authority.assertScope(actor, scope);
        if (input.purpose !== "read" && input.purpose !== "submit") denied();
        const candidate = pluginSecurityRecord(input.candidate, [
          "descriptor",
          "packageDigest",
        ]);
        const actual = {
          descriptor: parsePluginPackageDescriptor(candidate.descriptor),
          packageDigest: pluginInstallationDigest(candidate.packageDigest),
        };
        if (this.#binding.registry.authorizeCandidate(actual) !== "allow")
          return "deny";
        const response = pluginSecurityRecord(
          await this.#http.post(
            {
              url: this.#binding.tasks.publication.packageAuthority.url,
              serviceToken: this.#binding.tasks.packageToken,
            },
            {
              schemaVersion: "crewon.plugin-execution-package.v1",
              identity: {
                pluginId: actual.descriptor.pluginId,
                publisherId: actual.descriptor.publisherId,
                version: actual.descriptor.version,
                packageDigest: actual.packageDigest,
              },
              scope,
              purpose: input.purpose,
            },
            AbortSignal.any([signal, this.#requestSignal()]),
          ),
          ["outcome"],
        );
        await this.#assertRequest(actor);
        signal.throwIfAborted();
        if (response.outcome !== "allow" && response.outcome !== "deny")
          denied();
        return response.outcome;
      });
  readonly creditQuotes: ExtensionCreditQuotePort = Object.freeze({
    quoteGeneration: (
      input: Parameters<ExtensionCreditQuotePort["quoteGeneration"]>[0],
    ) =>
      this.#operation(async () => {
        const fields = pluginSecurityRecord(input, [
          "actor",
          "binding",
          "input",
          "commandRequestDigest",
        ]);
        const actor = pluginSecurityActor(fields.actor);
        await this.#assertRequest(actor);
        const result = await this.#quote.quoteGeneration(
          fields as Parameters<ExtensionCreditQuotePort["quoteGeneration"]>[0],
        );
        await this.#assertRequest(actor);
        return result;
      }),
  });

  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([
      this.#http.close(),
      ...this.#physical,
    ]).then(() => {}));
  }
  #assertOwner(actor: ActorContext): void {
    try {
      this.#lifetime.signal.throwIfAborted();
      if (this.#fileConfiguration !== undefined)
        assertDesktopPluginConfigurationFileCurrent(this.#fileConfiguration);
      assertDesktopInstalledPluginTaskConfigCurrent(this.#binding.tasks);
      assertDesktopInstalledPluginActivationConfigCurrent(
        this.#binding.activation,
      );
      this.#binding.authority.assertScope(
        pluginSecurityActor(actor),
        this.#binding.configuration.scope,
      );
      this.#binding.installation.assertProfileOwnership(actor);
      this.#binding.activationOwner.assertTaskPeerBorrow({
        ...this.#binding,
        activation: this.#binding.activation,
      });
      assertDesktopPluginConfigurationRuntime(this.#binding.installed, {
        ...this.#binding,
        activation: this.#binding.activationOwner,
      });
      this.#lifetime.signal.throwIfAborted();
    } catch {
      denied();
    }
  }
  async #assertRequest(
    actor: ActorContext = this.requests.currentActor(),
  ): Promise<void> {
    this.#assertOwner(actor);
    if (
      !same(this.requests.currentActor(), actor) ||
      !same(this.requests.currentScope(), this.#binding.configuration.scope)
    )
      denied();
    await this.requests.assertCurrent();
    this.#assertOwner(actor);
  }
  #requestSignal(): AbortSignal {
    this.#assertOwner(this.requests.currentActor());
    return AbortSignal.any([
      this.requests.currentSignal(),
      this.#lifetime.signal,
    ]);
  }
  async #operation<T>(work: () => Promise<T>): Promise<T> {
    this.#assertOwner(this.#binding.configuration.actor);
    const pending = Promise.resolve().then(work);
    this.#physical.add(pending);
    void pending.then(
      () => this.#physical.delete(pending),
      () => this.#physical.delete(pending),
    );
    return pending;
  }
}

function same(a: unknown, b: unknown): boolean {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_plugin_task_authority_unavailable",
  );
}
