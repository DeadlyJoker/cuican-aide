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
import { assertDesktopNativePluginTaskComposition } from "./desktop-native-plugin-task-runtime.ts";
import {
  assertDesktopNativePluginControlConfigCurrent,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { assertDesktopProjectFoundationStartupBinding } from "./desktop-project-foundation-startup.ts";
import { canonicalDesktopPluginConfiguration } from "./desktop-plugin-configuration-canonical.ts";

type ExecutionInput = Readonly<{
  configuration: DesktopPluginConfiguration;
  tasks: DesktopInstalledPluginTaskConfig | undefined;
  activation: DesktopInstalledPluginActivationConfig | undefined;
  projects: CreativeProjectCompositionConfig | undefined;
  nativeControl?: DesktopNativePluginControlConfig;
}>;
type Issue = Readonly<{
  bootstrap: DesktopPluginConfiguration;
  configurationDigest: string;
  tasks: DesktopInstalledPluginTaskConfig | undefined;
  activation: DesktopInstalledPluginActivationConfig | undefined;
  nativeControl: DesktopNativePluginControlConfig | undefined;
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
    (input.nativeControl === undefined &&
      (input.tasks === undefined || input.activation === undefined)) ||
    (input.nativeControl !== undefined &&
      (input.tasks !== undefined || input.activation !== undefined))
  )
    unavailable();
  for (const key of [
    "pluginUi",
    "textArtifacts",
    "textUi",
    "textRecovery",
    "conversations",
    "textPlans",
    "pluginGenerations",
    "pluginQueries",
    "historicalQueries",
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
  const digester = new NodeSha256ContentDigester();
  assertComposition(input, projects, digester);
  issued.set(
    projects!,
    Object.freeze({
      bootstrap: input.configuration,
      configurationDigest: digest(input.configuration, digester),
      tasks: input.tasks,
      activation: input.activation,
      nativeControl: input.nativeControl,
    }),
  );
  return projects;
}

/** Native-only bridge. The generic Standalone creator continues to reject paid project mappings. */
export function captureDesktopProjectCompositionConfig(
  input: ExecutionInput,
): CreativeProjectCompositionConfig | undefined {
  assertDesktopProjectFoundationStartupBinding(
    input.configuration,
    input.projects,
  );
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
    proof.activation !== input.activation ||
    proof.nativeControl !== input.nativeControl
  )
    unavailable();
  assertDesktopPluginConfigurationFileCurrent(proof.bootstrap);
  if (proof.nativeControl !== undefined)
    assertDesktopNativePluginControlConfigCurrent(proof.nativeControl);
  else {
    if (proof.tasks === undefined) unavailable();
    assertDesktopInstalledPluginTaskConfigFileIssued(proof.tasks);
  }
  const digester = new NodeSha256ContentDigester();
  if (digest(input.configuration, digester) !== proof.configurationDigest)
    unavailable();
  assertComposition(input, projects, digester);
  return projects;
}

function hasExecution(projects: CreativeProjectCompositionConfig | undefined) {
  return (
    projects?.pluginGenerations !== undefined ||
    projects?.pluginQueries !== undefined ||
    projects?.historicalQueries !== undefined
  );
}
function digest(
  configuration: DesktopPluginConfiguration,
  digester: ContentDigester,
) {
  return digester.sha256(canonicalDesktopPluginConfiguration(configuration));
}
function unavailable(): never {
  throw new Error("desktop_project_execution_authority_required");
}

function assertComposition(
  input: ExecutionInput,
  projects: CreativeProjectCompositionConfig | undefined,
  digester: ContentDigester,
): void {
  if (input.nativeControl !== undefined) {
    if (input.tasks !== undefined || input.activation !== undefined)
      unavailable();
    assertDesktopNativePluginTaskComposition({
      configuration: input.configuration,
      nativeControl: input.nativeControl,
      creativeProjects: projects,
    });
  } else {
    if (input.tasks === undefined || input.activation === undefined)
      unavailable();
    assertDesktopInstalledPluginTaskConfigFileIssued(input.tasks);
    assertDesktopInstalledPluginTaskComposition({
      configuration: input.configuration,
      tasks: input.tasks,
      activation: input.activation,
      creativeProjects: projects,
      digester,
    });
  }
}
