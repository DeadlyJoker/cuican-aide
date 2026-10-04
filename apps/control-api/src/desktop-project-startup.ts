import type {
  ActorContext,
  CreativeProjectAuthorizationAction,
  CreativeProjectAuthorizationPort,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import {
  captureCreativeProjectCompositionConfig,
  captureStandaloneCreativeProjectCompositionConfig,
  type CreativeProjectCompositionConfig,
} from "./creative-project-composition.ts";
import { createComfyUiProjectGenerationImageResultVerifier } from "./comfyui-image-result-verifier.ts";
import {
  capturePluginUiRecoveryConfiguration,
  type PluginUiRecoveryConfiguration,
} from "./plugin-ui-recovery-composition.ts";
import { pluginSecurityActor } from "./plugin-security-validation.ts";
import { assertDesktopPluginUiRecoveryConfiguration } from "./desktop-plugin-ui-recovery.ts";
import type { DesktopInstalledPluginTaskConfig } from "./desktop-installed-plugin-task-environment.ts";
import type { DesktopInstalledPluginActivationConfig } from "./desktop-installed-plugin-activation-environment.ts";
import type { DesktopNativePluginControlConfig } from "./desktop-native-plugin-control-environment.ts";
import { issueDesktopProjectExecutionConfiguration } from "./desktop-project-execution-startup.ts";

/** Issued private bootstrap data selects existing local capabilities; no supplier, quote or cloud policy is created. */
export function composeDesktopProjectStartup(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    actor: ActorContext;
    tasks?: DesktopInstalledPluginTaskConfig;
    activation?: DesktopInstalledPluginActivationConfig;
    nativeControl?: DesktopNativePluginControlConfig;
  }>,
): Readonly<{
  creativeProjects?: CreativeProjectCompositionConfig;
  uiRecovery?: PluginUiRecoveryConfiguration;
}> {
  const configuration = parseDesktopPluginConfiguration(input.configuration);
  const actor = pluginSecurityActor(input.actor);
  const owner = extensionCanonicalJson(configuration.actor);
  if (extensionCanonicalJson(actor) !== owner)
    throw new Error("desktop_plugin_owner_mismatch");
  if (configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v1")
    return Object.freeze({});
  const {
    version: _version,
    resultSelections,
    uiRecovery,
    ...data
  } = configuration.projects;
  const permitted = new Set<CreativeProjectAuthorizationAction>([
    "creativeProject:read",
    ...(data.pluginUi === undefined
      ? []
      : ([
          "creativeProject:create",
          "creativeProject:list",
          "creativeProject:write",
        ] as const)),
    ...(resultSelections === undefined
      ? []
      : (["creativeProject:write"] as const)),
  ]);
  const authorization: CreativeProjectAuthorizationPort = Object.freeze({
    authorize: async ({
      actor: current,
      action,
      resource,
    }: Parameters<CreativeProjectAuthorizationPort["authorize"]>[0]) => {
      try {
        if (
          extensionCanonicalJson(pluginSecurityActor(current)) !== owner ||
          resource.kind !== "creativeProject" ||
          resource.tenantId !== configuration.scope.tenantId ||
          resource.spaceId !== configuration.scope.spaceId ||
          !permitted.has(action)
        )
          return {
            outcome: "deny" as const,
            reasonCode: "desktop_project_scope_denied",
          };
        return { outcome: "allow" as const };
      } catch {
        return {
          outcome: "deny" as const,
          reasonCode: "desktop_project_scope_denied",
        };
      }
    },
  });
  const capture =
    configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? captureCreativeProjectCompositionConfig
      : captureStandaloneCreativeProjectCompositionConfig;
  const captured = capture({
    ...data,
    authorization,
    ...(resultSelections === undefined
      ? {}
      : {
          resultSelections: {
            version: resultSelections.version,
            verifier: createComfyUiProjectGenerationImageResultVerifier({
              identities: resultSelections.identities,
            }),
          },
        }),
  })!;
  const creativeProjects = issueDesktopProjectExecutionConfiguration({
    configuration: input.configuration,
    tasks: input.tasks,
    activation: input.activation,
    projects: captured,
    ...(input.nativeControl === undefined
      ? {}
      : { nativeControl: input.nativeControl }),
  })!;
  const recovery = capturePluginUiRecoveryConfiguration(uiRecovery, {
    publicationMode: "metadata-read",
  });
  return Object.freeze({
    creativeProjects,
    ...(recovery === undefined ? {} : { uiRecovery: recovery }),
  });
}

/** Pin optional Native recovery before creating a database or acquiring any adapter. */
export function captureDesktopProjectRecoveryStartup(
  input: Readonly<{
    runtimeConfiguration: Readonly<{
      uiRecovery?: PluginUiRecoveryConfiguration;
    }>;
    publications: DesktopPluginConfiguration["publications"];
    projects: CreativeProjectCompositionConfig | undefined;
  }>,
): PluginUiRecoveryConfiguration | undefined {
  const field = Object.getOwnPropertyDescriptor(
    input.runtimeConfiguration,
    "uiRecovery",
  );
  if (field !== undefined && (!field.enumerable || !("value" in field)))
    throw new Error("desktop_plugin_ui_recovery_configuration_invalid");
  return assertDesktopPluginUiRecoveryConfiguration({
    configuration: capturePluginUiRecoveryConfiguration(field?.value, {
      publicationMode: "metadata-read",
    }),
    publications: input.publications,
    metadataUi: input.projects?.pluginUi,
    selectionUi: input.projects?.selectionUi,
    pluginGenerations: input.projects?.pluginGenerations,
    pluginQueries: input.projects?.pluginQueries,
  });
}
