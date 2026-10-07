import {
  ApplicationError,
  type PluginUiCommittedTaskPort,
  type PluginUiRecoveryApplicationService,
} from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";
import { ProjectMediaGenerationPluginUiOwner } from "./project-media-generation-plugin-ui-owner.ts";

/** The explicit generation publication grants both logical entrypoints; metadata alone grants neither. */
export function composeDesktopProjectMediaGenerationUi(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    runtime: InstalledProjectMediaGenerationRuntime | undefined;
    fallback: PluginUiHostServiceAvailabilityPort | undefined;
    committedTasks: PluginUiCommittedTaskPort | undefined;
    recovery?: () => PluginUiRecoveryApplicationService | undefined;
  }>,
) {
  const grant =
    input.configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? input.configuration.projects.mediaGenerations
      : undefined;
  if (grant === undefined) return undefined;
  if (input.runtime === undefined)
    throw new Error("desktop_project_media_generation_ui_owner_required");
  const owner = new ProjectMediaGenerationPluginUiOwner({
    configuration: { publications: grant.publications },
    runtime: input.runtime,
    ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
  });
  const committedTasks = Object.freeze<PluginUiCommittedTaskPort>({
    isOutcome: (
      value,
    ): value is import("@crewon/application").PluginUiCommittedTaskOutcome =>
      owner.committedTasks.isOutcome(value) ||
      input.committedTasks?.isOutcome(value) === true,
    verify: (context, value) => {
      if (owner.committedTasks.isOutcome(value))
        return owner.committedTasks.verify(context, value);
      if (input.committedTasks?.isOutcome(value))
        return input.committedTasks.verify(context, value);
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_task_invalid",
      );
    },
  });
  return Object.freeze({
    owner,
    committedTasks,
    hostUiServices: owner.hostUiServices(input.fallback),
    close: () => owner.close(),
  });
}
