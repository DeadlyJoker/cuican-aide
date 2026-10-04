import type { ContentDigester } from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  captureCreativeProjectCompositionConfig,
  captureStandaloneCreativeProjectCompositionConfig,
  type CreativeProjectCompositionConfig,
} from "./creative-project-composition.ts";
import {
  assertDesktopPluginConfigurationFileCurrent,
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import type { DesktopInstalledPluginActivationConfig } from "./desktop-installed-plugin-activation-environment.ts";
import {
  assertDesktopInstalledPluginTaskConfigFileIssued,
  type DesktopInstalledPluginTaskConfig,
} from "./desktop-installed-plugin-task-environment.ts";
import { assertDesktopInstalledPluginTaskComposition } from "./desktop-installed-plugin-task-runtime.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";

type ExecutionInput = Readonly<{
  configuration: DesktopPluginConfiguration;
  tasks: DesktopInstalledPluginTaskConfig | undefined;
  activation: DesktopInstalledPluginActivationConfig | undefined;
  projects: CreativeProjectCompositionConfig | undefined;
}>;
type Issue = Readonly<{
  bootstrap: DesktopPluginConfiguration;
  configurationDigest: string;
  tasks: DesktopInstalledPluginTaskConfig;
  activation: DesktopInstalledPluginActivationConfig;
}>;
const issued = new WeakMap<object, Issue>();

/** Data in a bootstrap cannot grant execution. Both private files must actually be issued and current. */
export function issueDesktopProjectExecutionConfiguration(
  input: ExecutionInput,
): CreativeProjectCompositionConfig | undefined {
  const projects = captureCreativeProjectCompositionConfig(input.projects);
  if (!hasExecution(projects))
    return captureStandaloneCreativeProjectCompositionConfig(projects);
  if (
    parseDesktopPluginConfiguration(input.configuration).schemaVersion !==
    "crewon.desktop-plugin-bootstrap.v3"
  )
    return captureStandaloneCreativeProjectCompositionConfig(projects);
  assertDesktopPluginConfigurationFileCurrent(input.configuration);
  if (
    input.configuration.schemaVersion !==
      "crewon.desktop-plugin-bootstrap.v3" ||
    input.tasks === undefined ||
    input.activation === undefined
  )
    unavailable();
  for (const key of [
    "pluginUi",
    "pluginGenerations",
    "pluginQueries",
    "generationReads",
    "generationReadUi",
    "selectionUi",
  ] as const) {
    if (
      extensionCanonicalJson(projects![key] ?? null) !==
      extensionCanonicalJson(input.configuration.projects[key] ?? null)
    )
      unavailable();
  }
  assertDesktopInstalledPluginTaskConfigFileIssued(input.tasks);
  const digester = new NodeSha256ContentDigester();
  assertDesktopInstalledPluginTaskComposition({
    configuration: input.configuration,
    tasks: input.tasks,
    activation: input.activation,
    creativeProjects: projects,
    digester,
  });
  issued.set(
    projects!,
    Object.freeze({
      bootstrap: input.configuration,
      configurationDigest: digest(input.configuration, digester),
      tasks: input.tasks,
      activation: input.activation,
    }),
  );
  return projects;
}

/** Native-only bridge. The generic Standalone creator continues to reject paid project mappings. */
export function captureDesktopProjectCompositionConfig(
  input: ExecutionInput,
): CreativeProjectCompositionConfig | undefined {
  const projects = captureCreativeProjectCompositionConfig(input.projects);
  if (!hasExecution(projects))
    return captureStandaloneCreativeProjectCompositionConfig(projects);
  if (
    parseDesktopPluginConfiguration(input.configuration).schemaVersion !==
    "crewon.desktop-plugin-bootstrap.v3"
  )
    return captureStandaloneCreativeProjectCompositionConfig(projects);
  assertDesktopPluginConfigurationFileCurrent(input.configuration);
  const proof = issued.get(input.projects!);
  if (
    proof === undefined ||
    proof.tasks !== input.tasks ||
    proof.activation !== input.activation
  )
    unavailable();
  assertDesktopPluginConfigurationFileCurrent(proof.bootstrap);
  assertDesktopInstalledPluginTaskConfigFileIssued(proof.tasks);
  const digester = new NodeSha256ContentDigester();
  if (digest(input.configuration, digester) !== proof.configurationDigest)
    unavailable();
  assertDesktopInstalledPluginTaskComposition({
    configuration: input.configuration,
    tasks: proof.tasks,
    activation: proof.activation,
    creativeProjects: projects,
    digester,
  });
  return projects;
}

function hasExecution(projects: CreativeProjectCompositionConfig | undefined) {
  return (
    projects?.pluginGenerations !== undefined ||
    projects?.pluginQueries !== undefined
  );
}
function digest(
  configuration: DesktopPluginConfiguration,
  digester: ContentDigester,
) {
  return digester.sha256(
    extensionCanonicalJson(parseDesktopPluginConfiguration(configuration)),
  );
}
function unavailable(): never {
  throw new Error("desktop_project_execution_authority_required");
}
