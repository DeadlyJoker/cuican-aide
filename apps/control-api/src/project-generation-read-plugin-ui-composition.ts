import type { PluginProjectGenerationReadPublication } from "@crewon/plugin-host";
import {
  assertCreativeProjectPluginPublications,
  captureCreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";

/** Independent source publication approval; metadata and paid execution approvals do not imply it. */
export type ProjectGenerationReadPluginUiConfig = Readonly<{
  publications: readonly PluginProjectGenerationReadPublication[];
}>;

export function captureProjectGenerationReadPluginUiConfig(
  input: unknown,
): ProjectGenerationReadPluginUiConfig | undefined {
  return captureCreativeProjectPluginUiConfig(input);
}

export const assertProjectGenerationReadPluginPublications =
  assertCreativeProjectPluginPublications;
