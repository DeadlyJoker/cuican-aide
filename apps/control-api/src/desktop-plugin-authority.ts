import {
  ApplicationError,
  type ActorContext,
  type PluginInstallationAuthorizationAction,
  type PluginUiAuthorizationPort,
  type PluginCreativeProjectActionPublication,
} from "@crewon/application";
import { type PluginProfileScope } from "@crewon/domain";
import { installationSame } from "./production-plugin-installation-runtime-support.ts";
import {
  pluginSecurityActor,
  pluginSecurityInstallationRequest,
  pluginSecurityUiRequest,
} from "./plugin-security-validation.ts";
import {
  assertDesktopPluginConfigurationFileCurrent,
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  assertCreativeProjectPluginPublications,
  captureCreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";

/** A native-approved local owner grant for this Control lifetime. Configuration changes require restart. */
export class DesktopPluginAuthority {
  readonly #configuration: DesktopPluginConfiguration;
  readonly #fileConfiguration: DesktopPluginConfiguration | undefined;
  readonly #metadataPublications: readonly PluginCreativeProjectActionPublication[];
  readonly #withdrawalObservers = new Set<() => void>();
  #closed = false;
  constructor(
    configuration: DesktopPluginConfiguration,
    metadataPublications?: readonly PluginCreativeProjectActionPublication[],
  ) {
    this.#configuration = parseDesktopPluginConfiguration(configuration);
    this.#fileConfiguration =
      this.#configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
        ? configuration
        : undefined;
    if (this.#fileConfiguration !== undefined)
      assertDesktopPluginConfigurationFileCurrent(this.#fileConfiguration);
    const metadata =
      metadataPublications === undefined
        ? undefined
        : captureCreativeProjectPluginUiConfig({
            publications: metadataPublications,
          });
    assertCreativeProjectPluginPublications(
      metadata,
      this.#configuration.publications,
    );
    this.#metadataPublications = metadata?.publications ?? [];
  }
  assertActor(input: ActorContext): void {
    if (this.#closed) denied("desktop_plugin_authority_closed");
    if (
      !installationSame(pluginSecurityActor(input), this.#configuration.actor)
    )
      denied("desktop_plugin_owner_mismatch");
    if (this.#fileConfiguration !== undefined) {
      try {
        assertDesktopPluginConfigurationFileCurrent(this.#fileConfiguration);
      } catch (error) {
        this.withdraw();
        throw error;
      }
    }
  }
  assertScope(actor: ActorContext, scope: PluginProfileScope): void {
    this.assertActor(actor);
    if (!installationSame(scope, this.#configuration.scope))
      denied("desktop_plugin_profile_mismatch");
  }
  /** Host-owned lifetimes observe the same authority. Renderer rejection is
   * not withdrawal; explicit close or actual Native-file loss is.
   */
  registerWithdrawalObserver(observer: () => void): () => void {
    if (typeof observer !== "function")
      throw new Error("desktop_plugin_authority_observer_invalid");
    if (this.#closed) {
      observer();
      return () => {};
    }
    if (this.#withdrawalObservers.size >= 32)
      throw new Error("desktop_plugin_authority_observer_limit");
    this.#withdrawalObservers.add(observer);
    return () => {
      this.#withdrawalObservers.delete(observer);
    };
  }
  async profile(actor: ActorContext): Promise<PluginProfileScope> {
    this.assertActor(actor);
    return this.#configuration.scope;
  }
  async epoch(
    input: Readonly<{
      actor: ActorContext;
      scope: PluginProfileScope;
      action: PluginInstallationAuthorizationAction;
      pluginId: string | null;
      packageDigest: string | null;
    }>,
  ): Promise<string> {
    const request = pluginSecurityInstallationRequest({
      actor: input.actor,
      action: input.action,
      resource: {
        kind: "pluginInstallation",
        ...input.scope,
        pluginId: input.pluginId,
        packageDigest: input.packageDigest,
      },
    });
    this.assertScope(request.actor, input.scope);
    // The exact authenticated native owner may read and withdraw its history. Code activation
    // and source installation additionally require verified publisher/bytes approval in LocalHost.
    return this.#configuration.authorityEpoch;
  }
  readonly ui: PluginUiAuthorizationPort = {
    authorize: async (input) => {
      const request = pluginSecurityUiRequest(input);
      try {
        this.assertScope(request.actor, {
          tenantId: request.resource.tenantId,
          spaceId: request.resource.spaceId,
          profileId: request.resource.profileId,
        });
      } catch {
        return { outcome: "deny", reasonCode: "desktop_plugin_owner_mismatch" };
      }
      if (
        request.action === "invoke" &&
        !this.#metadataPublications.some(
          (publication) =>
            publication.pluginId === request.resource.pluginId &&
            publication.packageDigest === request.resource.packageDigest &&
            publication.contributionId === request.resource.contributionId,
        )
      )
        return { outcome: "deny", reasonCode: "plugin_ui_actions_unavailable" };
      if (
        request.resource.pluginId !== null &&
        !this.#configuration.publications.some(
          (publication) =>
            publication.pluginId === request.resource.pluginId &&
            publication.packageDigest === request.resource.packageDigest,
        )
      )
        return { outcome: "deny", reasonCode: "plugin_ui_publication_denied" };
      return {
        outcome: "allow",
        authorityEpoch: this.#configuration.authorityEpoch,
      };
    },
  };
  withdraw(): void {
    if (this.#closed) return;
    this.#closed = true;
    const observers = [...this.#withdrawalObservers];
    this.#withdrawalObservers.clear();
    for (const observer of observers) {
      // All observers are synchronous withdrawal owners. One cleanup failure
      // must not keep the other profiles admitted; their close still joins cleanup.
      try {
        observer();
      } catch {}
    }
  }
  close(): Promise<void> {
    this.withdraw();
    return Promise.resolve();
  }
}
function denied(code: string): never {
  throw new ApplicationError("authorization", code);
}
