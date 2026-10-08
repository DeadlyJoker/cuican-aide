import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import {
  assertDesktopPluginConfigurationFileCurrent,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { DesktopPluginInstallationRuntime } from "./desktop-plugin-installation-runtime.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import { createProjectFoundationPluginUiRuntime } from "./project-foundation-plugin-ui-composition.ts";
import { createProjectSourceUploadPluginUiRuntime } from "./project-source-upload-plugin-ui-composition.ts";

/** Actual current private bootstrap, original profile owner and independently declared metadata publications. */
export function createDesktopProjectFoundationPluginRuntime(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    projects: PreparedCreativeProjects | undefined;
    authority: DesktopPluginAuthority;
    installation(): DesktopPluginInstallationRuntime | null;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
) {
  const declared =
    input.configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? input.configuration.projectFoundation
      : undefined;
  const prepared = input.projects?.foundation;
  if (declared === undefined && prepared === undefined) return undefined;
  assertDesktopPluginConfigurationFileCurrent(input.configuration);
  if (
    declared === undefined ||
    prepared === undefined ||
    extensionCanonicalJson(declared.pluginUi ?? null) !==
      extensionCanonicalJson(prepared.pluginUi ?? null) ||
    extensionCanonicalJson(declared.uploads.pluginUi ?? null) !==
      extensionCanonicalJson(prepared.uploadUi ?? null)
  )
    throw new Error("desktop_project_foundation_startup_authority_required");
  const active = (context: PluginUiActionContext): void => {
    assertDesktopPluginConfigurationFileCurrent(input.configuration);
    input.authority.assertScope(context.actor, context.scope);
    const installation = input.installation();
    if (installation === null)
      throw new ApplicationError(
        "authorization",
        "desktop_project_foundation_unavailable",
      );
    installation.assertProfileOwnership(context.actor);
  };
  const current = async (context: PluginUiActionContext) => active(context);
  const foundations =
    prepared.pluginUi === undefined
      ? undefined
      : createProjectFoundationPluginUiRuntime({
          configuration: prepared.pluginUi,
          foundations: prepared.service,
          authorization: { authorize: current, assertActive: active },
          ...(input.fallback === undefined
            ? {}
            : { hostUiServices: input.fallback }),
        });
  let uploads:
    | ReturnType<typeof createProjectSourceUploadPluginUiRuntime>
    | undefined;
  try {
    const fallback = foundations?.hostUiServices ?? input.fallback;
    uploads =
      prepared.uploadUi === undefined
        ? undefined
        : createProjectSourceUploadPluginUiRuntime({
            configuration: prepared.uploadUi,
            uploads: prepared.uploads,
            authorization: { authorize: current, authorizePart: current },
            ...(fallback === undefined ? {} : { hostUiServices: fallback }),
          });
  } catch (error) {
    void foundations?.close();
    throw error;
  }
  return Object.freeze({
    foundations,
    uploads,
    hostUiServices:
      uploads?.hostUiServices ?? foundations?.hostUiServices ?? input.fallback,
    close: async () => {
      const results = await Promise.allSettled([
        uploads?.close(),
        foundations?.close(),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(
          errors,
          "desktop_project_foundation_cleanup_failed",
        );
    },
  });
}
