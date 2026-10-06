import { extensionCanonicalJson } from "@crewon/domain";
import { PluginInstallationApplicationService } from "./plugin-installation-application-service.ts";
import { ExtensionConfigurationApplicationService } from "./extension-configuration-application-service.ts";
import {
  parseProjectMaterialPreparationRequest,
  parseProjectMaterialPreparationTarget,
} from "./project-material-preparation-record.ts";
import type { ProjectMaterialPreparationRequest } from "./project-material-preparation-port.ts";

/** Current host profile and actual authorized installation/configuration reads.
 * This snapshot does not grant network access or prove deployed package bytes.
 */
export class ProjectMaterialTargetApplicationService {
  readonly #selection: PluginInstallationApplicationService["getSelection"];
  readonly #package: PluginInstallationApplicationService["getPackage"];
  readonly #configuration: ExtensionConfigurationApplicationService["getConfiguration"];
  constructor(
    input: Readonly<{
      installations: PluginInstallationApplicationService;
      configurations: ExtensionConfigurationApplicationService;
    }>,
  ) {
    if (
      !(input.installations instanceof PluginInstallationApplicationService) ||
      !(
        input.configurations instanceof ExtensionConfigurationApplicationService
      )
    )
      fail("dependency_invalid");
    this.#selection =
      PluginInstallationApplicationService.prototype.getSelection.bind(
        input.installations,
      );
    this.#package =
      PluginInstallationApplicationService.prototype.getPackage.bind(
        input.installations,
      );
    this.#configuration =
      ExtensionConfigurationApplicationService.prototype.getConfiguration.bind(
        input.configurations,
      );
  }
  async resolveTarget(input: ProjectMaterialPreparationRequest) {
    const request = parseProjectMaterialPreparationRequest(input),
      actor = request.source.actor,
      query = { pluginId: request.target.pluginId },
      selection = await this.#selection(actor, query);
    if (
      !selection ||
      selection.state !== "enabled" ||
      !selection.selectedPackageDigest ||
      selection.profileId !== request.target.profileId
    )
      fail("selection_unavailable");
    const pkg = await this.#package(actor, {
        packageDigest: selection.selectedPackageDigest,
      }),
      configurationQuery = {
        ...query,
        revision: request.target.configurationRevision,
      },
      configuration = await this.#configuration(actor, configurationQuery);
    if (!pkg || !configuration) fail("configuration_unavailable");
    const target = parseProjectMaterialPreparationTarget(
      {
        installation: {
          tenantId: selection.tenantId,
          spaceId: selection.spaceId,
          profileId: selection.profileId,
          pluginId: pkg.pluginId,
          publisherId: pkg.publisherId,
          version: pkg.version,
          packageDigest: pkg.packageDigest,
          selectionRevision: selection.revision,
        },
        selection,
        package: pkg,
        configuration,
      },
      request,
    );
    // Recheck both after the independent reads. A changed host profile/selection never rebinds this request.
    const current = await this.#selection(actor, query),
      currentConfiguration = await this.#configuration(
        actor,
        configurationQuery,
      );
    if (
      extensionCanonicalJson(current) !==
        extensionCanonicalJson(target.selection) ||
      extensionCanonicalJson(currentConfiguration) !==
        extensionCanonicalJson(target.configuration)
    )
      fail("changed");
    return target;
  }
}
function fail(code: string): never {
  throw new Error(`project_material_target_${code}`);
}
