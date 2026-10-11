import {
  ApplicationError,
  type ActorContext,
  type PluginInstallationAuthorizationAction,
} from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import type { SqlitePluginInstallationProfileOwner } from "@crewon/store";
import type {
  LocalPluginInstallationHostDependencies,
  PluginActivationCandidate,
  PluginNodeCommitCandidate,
  PluginNodeHost,
  PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { verifyDesktopInstalledPackage } from "./desktop-plugin-runtime-support.ts";

/** Original profile policies, shared by its unique installation and instance owner. */
export function createDesktopPluginInstallationHostPolicy(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    registry: DesktopPluginSourceRegistry;
    nodes: Pick<PluginNodeHost, "serviceIdentities">;
    signal: AbortSignal;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    assertOperation(actor: ActorContext, scope: PluginProfileScope): void;
    assertAvailable(): void;
    refreshAuthority(
      request: Readonly<{
        actor: ActorContext;
        scope: PluginProfileScope;
        action: PluginInstallationAuthorizationAction;
        pluginId: string | null;
        packageDigest: string | null;
      }>,
    ): Promise<string>;
    checkUiServices(candidate: PluginActivationCandidate): void;
    authorizeCommit(
      selection: Parameters<
        LocalPluginInstallationHostDependencies["authorizeCommit"]
      >[0]["selection"],
      candidate: PluginNodeCommitCandidate | null,
    ): "allow" | "deny";
  }>,
): Omit<
  LocalPluginInstallationHostDependencies,
  "profile" | "installRoot" | "nodeHost" | "assertOpen"
> {
  const activate = async (
    value: Parameters<
      LocalPluginInstallationHostDependencies["authorizeActivation"]
    >[0],
    action: PluginInstallationAuthorizationAction,
  ) => {
    input.assertOperation(value.actor, value.scope);
    if (input.registry.authorizeCandidate(value.candidate) !== "allow")
      return "deny" as const;
    await input.refreshAuthority({
      actor: value.actor,
      scope: value.scope,
      action,
      pluginId: value.candidate.descriptor.pluginId,
      packageDigest: value.candidate.packageDigest,
    });
    return "allow" as const;
  };
  return Object.freeze({
    hostUiServices: input.hostUiServices,
    resolveSource: async ({ actor, scope, sourceId }) => {
      input.assertOperation(actor, scope);
      const directory = await input.registry.resolveSource(sourceId);
      input.assertAvailable();
      return directory;
    },
    authorizeInstallation: (value) =>
      activate(value, "pluginInstallation:install"),
    authorizeActivation: (value) =>
      activate(value, "pluginInstallation:select"),
    validateCompatibility: async (value) => {
      input.assertOperation(value.actor, value.scope);
      if (value.descriptor !== null && value.package !== null)
        await verifyDesktopInstalledPackage({
          installRoot: input.configuration.installRoot,
          package: value.package,
          registry: input.registry,
          signal: input.signal,
          hostUiServices: input.hostUiServices,
        });
      if (
        value.nextSelection.state === "enabled" &&
        value.descriptor !== null
      ) {
        if (value.descriptor.entrypoints.node === null)
          input.checkUiServices({
            descriptor: value.descriptor,
            packageDigest: value.package!.packageDigest,
          });
        else
          for (const requirement of value.descriptor.requires)
            if (
              !requirement.optional &&
              !input.nodes
                .serviceIdentities()
                .some(
                  (service) =>
                    service.service === requirement.service &&
                    service.apiVersion === requirement.apiVersion,
                )
            )
              throw new ApplicationError(
                "conflict",
                "plugin_dependency_unavailable",
              );
      }
      input.assertAvailable();
    },
    authorizeCommit: ({ actor, scope, selection, candidate }) => {
      input.assertOperation(actor, scope);
      return input.authorizeCommit(selection, candidate);
    },
  });
}

/** Checks the actual selected provider packages without granting any activation. */
export function assertDesktopPluginInstallationDependencies(
  input: Readonly<{
    dependencies: PluginNodeCommitCandidate["dependencyIdentities"];
    scope: PluginProfileScope;
    owner: SqlitePluginInstallationProfileOwner;
    registry: DesktopPluginSourceRegistry;
    assertAvailable(): void;
  }>,
): void {
  input.assertAvailable();
  for (const dependency of input.dependencies) {
    if (dependency.provider === null) continue;
    const provider = dependency.provider;
    const selection = input.owner.currentSelection({
      scope: input.scope,
      pluginId: provider.pluginId,
    });
    const pkg = input.owner.currentSelectedPackage({
      scope: input.scope,
      pluginId: provider.pluginId,
    });
    if (
      selection?.state !== "enabled" ||
      pkg === null ||
      pkg.packageDigest !== provider.packageDigest ||
      pkg.version !== provider.version ||
      input.registry.authorizeIdentity(pkg) !== "allow"
    )
      throw new ApplicationError(
        "authorization",
        "plugin_installation_dependency_changed",
      );
  }
  input.assertAvailable();
}
