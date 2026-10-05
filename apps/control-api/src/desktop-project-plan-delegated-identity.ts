import { ApplicationError } from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { InstalledPluginDelegatedIdentityPort } from "./installed-plugin-delegated-identity.ts";
import { captureInstalledPluginDelegatedIdentityInput } from "./installed-plugin-delegated-identity.ts";

/** Rechecks the current Main-signed bootstrap and exact approved publication on every background fence. */
export function createDesktopProjectPlanDelegatedIdentity(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    authority: DesktopPluginAuthority;
    assertCurrent(): void;
  }>,
): InstalledPluginDelegatedIdentityPort {
  const { configuration, authority } = input,
    assertCurrent = input.assertCurrent.bind(input);
  return Object.freeze<InstalledPluginDelegatedIdentityPort>({
    resolveCurrentActor: async (provided, signal) => {
      signal.throwIfAborted();
      const value = captureInstalledPluginDelegatedIdentityInput(provided);
      assertCurrent();
      authority.assertScope(value.actor, value.scope);
      if (
        configuration.schemaVersion !== "crewon.desktop-plugin-bootstrap.v3" ||
        extensionCanonicalJson(value.actor) !==
          extensionCanonicalJson(configuration.actor) ||
        extensionCanonicalJson(value.scope) !==
          extensionCanonicalJson(configuration.scope) ||
        !configuration.projects.textPlans?.publications.some(
          (p) =>
            p.pluginId === value.installation.pluginId &&
            p.packageDigest === value.installation.packageDigest &&
            p.contributionId === value.delegation.contributionId,
        ) ||
        !configuration.sources.some(
          (p) =>
            p.pluginId === value.installation.pluginId &&
            p.publisherId === value.installation.publisherId &&
            p.version === value.installation.version &&
            p.packageDigest === value.installation.packageDigest,
        )
      )
        throw new ApplicationError(
          "authorization",
          "project_text_plan_authorization_unavailable",
        );
      signal.throwIfAborted();
      assertCurrent();
      authority.assertScope(configuration.actor, value.scope);
      return configuration.actor;
    },
  });
}
