import type { ProductionPostgresControlApiConfig } from "./production-composition.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { parseProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";
import { captureProductionPluginUiActions } from "./production-plugin-ui-composition.ts";
import { assertInstalledPluginTaskConfiguration } from "./installed-plugin-task-environment.ts";
import { assertInstalledPluginConfigurationConfig } from "./installed-plugin-configuration-environment.ts";

export function validateProductionConfig(
  config: ProductionPostgresControlApiConfig,
): void {
  if (
    config.creativeProjects !== undefined &&
    !(config.identity instanceof ProductionControlApiIdentity)
  )
    throw new Error("production_creative_project_identity_required");
  if (config.pluginConfiguration !== undefined) {
    assertInstalledPluginConfigurationConfig(
      config.pluginConfiguration.configuration,
    );
    if (
      !(config.identity instanceof ProductionControlApiIdentity) ||
      config.pluginTasks !== undefined
    )
      throw new Error("production_plugin_configuration_conflict");
    const root = config.pluginConfiguration.configuration.installRoot;
    if (
      (config.pluginUi !== undefined &&
        parseProductionPluginUiConfiguration(config.pluginUi.configuration)
          .installRoot !== root) ||
      (config.pluginInstallation !== undefined &&
        parseProductionPluginInstallationConfiguration(
          config.pluginInstallation.configuration,
        ).installRoot !== root)
    )
      throw new Error("production_plugin_install_root_mismatch");
  }
  if (config.pluginTasks !== undefined) {
    assertInstalledPluginTaskConfiguration(config.pluginTasks.configuration);
    if (
      !(config.identity instanceof ProductionControlApiIdentity) ||
      config.pluginUi === undefined ||
      config.pluginUi.actions !== undefined ||
      config.pluginUi.committedTasks !== undefined ||
      config.pluginUi.ownedTaskActions !== undefined ||
      config.pluginUi.ownedProjectGenerationActions !== undefined ||
      parseProductionPluginUiConfiguration(config.pluginUi.configuration)
        .installRoot !== config.pluginTasks.configuration.installRoot
    )
      throw new Error("production_plugin_task_configuration_conflict");
  }
  requireMethod(
    config.identity,
    "resolveActor",
    "production_identity_required",
  );
  requireMethod(
    config.authorization,
    "authorize",
    "production_authorization_required",
  );
  if (config.pluginCreditAuthorization !== undefined)
    requireMethod(
      config.pluginCreditAuthorization,
      "authorize",
      "production_plugin_credit_authorization_required",
    );
  requireMethod(config.artifactStore, "close", "artifact_store_required");
  if (config.pluginInstallation !== undefined) {
    if (!(config.identity instanceof ProductionControlApiIdentity))
      throw new Error("production_plugin_installation_identity_required");
    parseProductionPluginInstallationConfiguration(
      config.pluginInstallation.configuration,
    );
    if (
      config.pluginUi !== undefined &&
      parseProductionPluginInstallationConfiguration(
        config.pluginInstallation.configuration,
      ).installRoot !==
        parseProductionPluginUiConfiguration(config.pluginUi.configuration)
          .installRoot
    )
      throw new Error("production_plugin_install_root_mismatch");
  }
  if (config.pluginUi !== undefined) {
    if (!(config.identity instanceof ProductionControlApiIdentity))
      throw new Error("production_plugin_ui_identity_required");
    parseProductionPluginUiConfiguration(config.pluginUi.configuration);
    captureProductionPluginUiActions(config.pluginUi);
    if (config.pluginUi.actions !== undefined)
      requireMethod(
        config.pluginUi.actions,
        "invoke",
        "production_plugin_ui_actions_invalid",
      );
    if (config.pluginUi.committedTasks !== undefined) {
      requireMethod(
        config.pluginUi.committedTasks,
        "isOutcome",
        "production_plugin_ui_committed_tasks_invalid",
      );
      requireMethod(
        config.pluginUi.committedTasks,
        "verify",
        "production_plugin_ui_committed_tasks_invalid",
      );
    }
  }
  if (config.providerProbeWorkers !== undefined) {
    requireMethod(
      config.providerProbeWorkers,
      "resolve",
      "production_provider_probe_registry_invalid",
    );
  }
  requireBounded(
    config.connectionString,
    8 * 1_024,
    "production_database_url_invalid",
  );
  requireBounded(
    config.artifactEncryptionKeyId,
    512,
    "artifact_encryption_key_id_invalid",
  );
}

function requireMethod(value: unknown, method: string, code: string): void {
  if (
    value === null ||
    typeof value !== "object" ||
    !(method in value) ||
    typeof (value as Record<string, unknown>)[method] !== "function"
  ) {
    throw new Error(code);
  }
}

function requireBounded(value: unknown, maximum: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new Error(code);
  }
}
