import assert from "node:assert/strict";
import { chmod, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ActorContext } from "@crewon/application";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import type { PluginProfileScope } from "@crewon/domain";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import {
  parseProductionPluginInstallationConfiguration,
  type ProductionPluginInstallationSource,
} from "./production-plugin-installation-environment.ts";
import type { ProductionPluginUiPublication } from "./production-plugin-ui-environment.ts";
import {
  pluginSecurityInstallationRequest,
  pluginSecurityUiDecision,
} from "./plugin-security-validation.ts";

export type MainRecoveryManagementPackage = Readonly<{
  descriptor: PluginPackageDescriptor;
  packageDigest: string;
}>;

function uiPublication(
  installed: MainRecoveryManagementPackage,
): ProductionPluginUiPublication {
  const { descriptor, packageDigest } = installed;
  const ui = descriptor.entrypoints.ui;
  assert.ok(ui?.mode === "trustedModule");
  const publicAssets = Object.freeze(
    descriptor.files
      .map((file) => file.path)
      .filter((path) => path === ui.path || path.startsWith("assets/"))
      .sort(),
  );
  assert.ok(publicAssets.includes(ui.path));
  return Object.freeze({
    pluginId: descriptor.pluginId,
    publisherId: descriptor.publisherId,
    packageDigest,
    publicAssets,
  });
}

/** Only full-App opt-in adds management. Original Main's UI publication is unchanged. */
export async function mainRecoveryManagementEnvironment(
  input: Readonly<{
    enabled: boolean;
    root: string;
    installRoot: string;
    authorityOrigin: string;
    authorityToken: string;
    sourceDirectory: string;
    targetDirectory: string;
    source: MainRecoveryManagementPackage;
    target: MainRecoveryManagementPackage;
  }>,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    CREWON_PLUGIN_UI_PUBLICATIONS_JSON: JSON.stringify(
      (input.enabled ? [input.source, input.target] : [input.source]).map(
        uiPublication,
      ),
    ),
  };
  if (!input.enabled) return environment;
  const directory = join(input.root, "management-sources");
  await mkdir(directory, { mode: 0o700 });
  const packages = [
    {
      sourceId: "named-main-source",
      directory: input.sourceDirectory,
      descriptor: input.source.descriptor,
      packageDigest: input.source.packageDigest,
    },
    {
      sourceId: "named-main-krea2",
      directory: input.targetDirectory,
      descriptor: input.target.descriptor,
      packageDigest: input.target.packageDigest,
    },
  ];
  const sources: ProductionPluginInstallationSource[] = [];
  for (const installed of packages) {
    const destination = join(directory, installed.sourceId);
    await cp(installed.directory, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await chmod(destination, 0o700);
    const verified = await verifyLocalPluginPackage({ directory: destination });
    assert.deepEqual(verified.descriptor, installed.descriptor);
    assert.equal(verified.packageDigest, installed.packageDigest);
    sources.push({
      sourceId: installed.sourceId,
      directory: destination,
      pluginId: verified.descriptor.pluginId,
      publisherId: verified.descriptor.publisherId,
      version: verified.descriptor.version,
      packageDigest: verified.packageDigest,
    });
  }
  const configuration = parseProductionPluginInstallationConfiguration({
    installRoot: input.installRoot,
    sources,
    profileAuthority: {
      url: `${input.authorityOrigin}/profile`,
      serviceToken: input.authorityToken,
    },
    policyAuthority: {
      url: `${input.authorityOrigin}/installation-policy`,
      serviceToken: input.authorityToken,
    },
    timeoutMs: 10_000,
  });
  return {
    ...environment,
    CREWON_PLUGIN_INSTALLATION_ENABLED: "1",
    CREWON_PLUGIN_INSTALLATION_INSTALL_ROOT: configuration.installRoot,
    CREWON_PLUGIN_INSTALLATION_SOURCES_JSON: JSON.stringify(
      configuration.sources,
    ),
    CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_URL:
      configuration.profileAuthority.url,
    CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_TOKEN: input.authorityToken,
    CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_URL:
      configuration.policyAuthority.url,
    CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_TOKEN: input.authorityToken,
    CREWON_PLUGIN_INSTALLATION_AUTHORITY_TIMEOUT_MS: String(
      configuration.timeoutMs,
    ),
  };
}

/** Named TLS authority approves only this fixture's actual package identities and profile. */
export function mainRecoveryInstallationDecision(
  input: Readonly<{
    request: unknown;
    actor: ActorContext;
    profileScope: PluginProfileScope;
    packages: readonly MainRecoveryManagementPackage[];
  }>,
) {
  const request = pluginSecurityInstallationRequest(input.request);
  assert.deepEqual(request.actor, input.actor);
  assert.deepEqual(
    {
      tenantId: request.resource.tenantId,
      spaceId: request.resource.spaceId,
      profileId: request.resource.profileId,
    },
    input.profileScope,
  );
  const { pluginId, packageDigest } = request.resource;
  const matched = input.packages.some(
    (installed) =>
      (pluginId === null || pluginId === installed.descriptor.pluginId) &&
      (packageDigest === null || packageDigest === installed.packageDigest),
  );
  const scopedRead = request.action === "pluginInstallation:read" && matched;
  const exactMutation = pluginId !== null && packageDigest !== null && matched;
  return pluginSecurityUiDecision(
    scopedRead || exactMutation
      ? { outcome: "allow", authorityEpoch: "named-main-installation-epoch" }
      : {
          outcome: "deny",
          reasonCode: "named_main_installation_identity_unapproved",
        },
  );
}
