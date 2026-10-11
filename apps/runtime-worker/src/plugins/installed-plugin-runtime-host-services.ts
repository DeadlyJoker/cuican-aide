import type {
  PluginHostService,
  PluginNodeHostServiceRegistration,
} from "@crewon/plugin-host";
import type { InstalledPluginProjectServices } from "./installed-plugin-project-services.ts";

/** Assemble actual captured owners; metadata and per-call qualification remain independently checked. */
export function installedPluginRuntimeHostServices(
  input: Readonly<{
    shared: readonly PluginNodeHostServiceRegistration[] | undefined;
    project: InstalledPluginProjectServices | null;
    media: PluginHostService | null;
  }>,
): readonly PluginHostService[] {
  return Object.freeze([
    ...(input.shared ?? []).map((entry) => entry.implementation),
    ...(input.project?.hostServices() ?? []),
    ...(input.media === null ? [] : [input.media]),
  ]);
}
