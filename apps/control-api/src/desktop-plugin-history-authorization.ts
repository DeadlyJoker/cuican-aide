import type { AuthorizationPort } from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionRunBinding,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import type { SqliteRunStore } from "@crewon/store";
import type { ContentDigester } from "@crewon/application";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { DesktopPluginInstallationRuntime } from "./desktop-plugin-installation-runtime.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { pluginSecurityActor } from "./plugin-security-validation.ts";

/** Explicit cold history grant. It cannot authorize configuration writes, task submission, provider queries or funding. */
export function createDesktopPluginHistoryAuthorization(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    authority: DesktopPluginAuthority;
    installation: DesktopPluginInstallationRuntime;
    requests: InstalledPluginRequestOwner;
    store: SqliteRunStore;
    digester: ContentDigester;
  }>,
): AuthorizationPort {
  const { configuration, authority, installation, requests, store } = input;
  const ledger = store.pluginInstallationStore();
  const extensions = store.extensionStore();
  const current = async () => {
    await requests.assertCurrent();
    const actor = requests.currentActor();
    authority.assertScope(actor, requests.currentScope());
    installation.assertProfileOwnership(actor);
    authority.assertScope(actor, configuration.scope);
  };
  const ownsNamespace = async (pluginId: string) => {
    if (configuration.sources.some((source) => source.pluginId === pluginId))
      return true;
    const selection = await ledger.loadSelection({
      scope: configuration.scope,
      pluginId,
    });
    // Disabled/uninstalled packages retain authorized history; revoked business activation
    // remains rejected by the original ExtensionReadApplicationService.
    return selection !== null;
  };
  return Object.freeze({
    authorize: async (value: Parameters<AuthorizationPort["authorize"]>[0]) => {
      await current();
      const actor = pluginSecurityActor(value.actor);
      const resource = value.resource;
      if (
        extensionCanonicalJson(actor) !==
          extensionCanonicalJson(requests.currentActor()) ||
        resource.tenantId !== configuration.scope.tenantId ||
        resource.spaceId !== configuration.scope.spaceId
      )
        return denied();
      if (value.action === "extension:query" && resource.kind === "extension") {
        const allowed = await ownsNamespace(resource.pluginId);
        await current();
        return allowed ? { outcome: "allow" as const } : denied();
      }
      if (
        value.action !== "run:read" ||
        resource.kind !== "run" ||
        resource.runId === null ||
        resource.threadId === null
      )
        return denied();
      const locator = {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: resource.runId,
      };
      const run = await store.loadRunInSpace(locator);
      const rawBinding = await extensions.loadExtensionRunBinding(locator);
      const rawAdmission = await extensions.loadPluginTaskAdmission(locator);
      await current();
      if (run === null || rawBinding === null || rawAdmission === null)
        return denied();
      const binding = parseExtensionRunBinding(rawBinding, input.digester);
      const admission = parsePluginTaskAdmission(rawAdmission);
      if (
        run.tenantId !== actor.tenantId ||
        run.spaceId !== actor.spaceId ||
        run.runId !== resource.runId ||
        run.threadId !== resource.threadId ||
        run.createdByActorId !== actor.actorId ||
        binding.tenantId !== actor.tenantId ||
        binding.spaceId !== actor.spaceId ||
        binding.runId !== run.runId ||
        binding.threadId !== run.threadId ||
        binding.actorId !== actor.actorId ||
        binding.source !== null ||
        admission.tenantId !== actor.tenantId ||
        admission.spaceId !== actor.spaceId ||
        admission.profileId !== configuration.scope.profileId ||
        admission.principalId !== actor.principalId ||
        admission.actorId !== actor.actorId ||
        admission.runId !== run.runId ||
        admission.threadId !== run.threadId ||
        admission.pluginId !== binding.pluginId ||
        admission.extensionBindingDigest !== binding.bindingDigest ||
        !(await ownsNamespace(binding.pluginId))
      )
        return denied();
      const pkg = await ledger.loadPackage({
        scope: configuration.scope,
        packageDigest: admission.packageDigest,
      });
      await current();
      if (
        pkg === null ||
        pkg.tenantId !== actor.tenantId ||
        pkg.spaceId !== actor.spaceId ||
        pkg.profileId !== admission.profileId ||
        pkg.pluginId !== admission.pluginId ||
        pkg.publisherId !== admission.publisherId ||
        pkg.version !== admission.version ||
        pkg.packageDigest !== admission.packageDigest
      )
        return denied();
      return { outcome: "allow" as const };
    },
  });
}

function denied() {
  return {
    outcome: "deny" as const,
    reasonCode: "desktop_plugin_history_authority_denied",
  };
}
