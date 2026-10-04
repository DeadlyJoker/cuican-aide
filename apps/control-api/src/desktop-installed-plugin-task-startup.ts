import type { DesktopInstalledPluginActivationConfig } from "./desktop-installed-plugin-activation-environment.ts";
import {
  assertDesktopInstalledPluginTaskConfigFileIssued,
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV,
  type DesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import { assertDesktopInstalledPluginTaskComposition } from "./desktop-installed-plugin-task-runtime.ts";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";

/** Capture explicit Main input before any file await. Absent opt-in inspects no credentials. */
export function snapshotDesktopInstalledPluginTaskEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> | undefined {
  const field = Object.getOwnPropertyDescriptor(
    environment,
    DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV,
  );
  if (field === undefined || ("value" in field && field.value === undefined))
    return undefined;
  if (
    !field.enumerable ||
    !("value" in field) ||
    typeof field.value !== "string"
  )
    invalid();
  // The four explicit token references become known only after the private file is read.
  // Snapshot data descriptors without invoking ambient getters or retaining mutable env.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(environment))
        .filter(
          ([, descriptor]) =>
            descriptor.enumerable &&
            "value" in descriptor &&
            (descriptor.value === undefined ||
              typeof descriptor.value === "string"),
        )
        .map(([name, descriptor]) => [name, descriptor.value]),
    ),
  );
}

/** The Standalone entry accepts only the actual private-file issue, never a parsed DTO. */
export function captureDesktopInstalledPluginTaskStartup(
  input: Readonly<{
    desktopPluginTasks?: DesktopInstalledPluginTaskConfig;
    desktopPluginActivation?: DesktopInstalledPluginActivationConfig;
  }>,
  configuration: DesktopPluginConfiguration,
): Readonly<{
  tasks: DesktopInstalledPluginTaskConfig | undefined;
  activation: DesktopInstalledPluginActivationConfig | undefined;
}> {
  const tasks = optionalData(input, "desktopPluginTasks");
  const activation = optionalData(input, "desktopPluginActivation");
  if (tasks !== undefined) {
    assertDesktopInstalledPluginTaskConfigFileIssued(tasks);
    assertDesktopInstalledPluginTaskComposition({
      configuration,
      tasks,
      activation,
      digester: new NodeSha256ContentDigester(),
    });
  }
  return Object.freeze({ tasks, activation });
}

function optionalData<T extends object, K extends keyof T>(
  input: T,
  name: K,
): T[K] | undefined {
  const field = Object.getOwnPropertyDescriptor(input, name);
  if (field === undefined) {
    if (name in input) invalid();
    return undefined;
  }
  if (!field.enumerable || !("value" in field)) invalid();
  return field.value as T[K];
}

function invalid(): never {
  throw new Error("desktop_installed_plugin_task_configuration_invalid");
}
