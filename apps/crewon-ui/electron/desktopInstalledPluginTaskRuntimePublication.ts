import { inspect } from "node:util";
import { join } from "node:path";
import type { DesktopInstalledPluginActivationFiles } from "./desktopInstalledPluginActivationFiles.ts";
import {
  assertDesktopInstalledPluginRuntimeConfiguration,
  desktopInstalledPluginAbsolutePath,
  desktopInstalledPluginInvalid as invalid,
  desktopInstalledPluginRecord as record,
  desktopInstalledPluginTaskExecutionSettings,
  type EnabledDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  assertDesktopPluginBootstrapIssued,
  type DesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import {
  createDesktopInstalledPluginTaskFiles,
  type DesktopInstalledPluginTaskFiles,
} from "./desktopInstalledPluginTaskFiles.ts";

const TASK_PATH = "CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH";
export type DesktopInstalledPluginTaskRuntimePublication = Readonly<{
  environmentNames: readonly string[];
  /** The supplied allowlist is the actual caller's already captured Worker authority tokens. */
  project(
    environment: NodeJS.ProcessEnv,
    workerAuthorityTokens?: Readonly<Record<string, string>>,
  ): NodeJS.ProcessEnv;
  controlAfterPeer(
    environment: NodeJS.ProcessEnv,
    activationFiles: DesktopInstalledPluginActivationFiles,
  ): NodeJS.ProcessEnv;
  assertCurrent(): void;
  withdraw(): void;
  /** Called only after the parent has physically joined all consumers. Clears secrets even on cleanup failure. */
  close(): void;
}>;

/** Synchronous capture before children. Genuine older configurations read no task refs or other inputs. */
export function captureDesktopInstalledPluginTaskRuntimePublication(
  input: Readonly<{
    configuration: EnabledDesktopInstalledPluginRuntimeConfiguration;
    dataDirectory: string;
    bootstrap: DesktopPluginBootstrap;
    sharedEnvironment: NodeJS.ProcessEnv;
    workerEnvironment: NodeJS.ProcessEnv;
  }>,
): DesktopInstalledPluginTaskRuntimePublication | null {
  const configuration = input.configuration;
  const settings = desktopInstalledPluginTaskExecutionSettings(configuration);
  if (settings === null) return null;
  const dataDirectory = desktopInstalledPluginAbsolutePath(input.dataDirectory);
  assertDesktopInstalledPluginRuntimeConfiguration(
    configuration,
    dataDirectory,
  );
  const bootstrap = input.bootstrap;
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
  if (
    manifest.installRoot !== join(dataDirectory, "plugins") ||
    manifest.authorityEpoch !== bootstrap.authorityEpoch ||
    settings.uiPublications.some(
      (grant) =>
        !manifest.sources.some(
          (source) =>
            source.pluginId === grant.pluginId &&
            source.packageDigest === grant.packageDigest,
        ) ||
        !manifest.publications.some(
          (publication) =>
            publication.pluginId === grant.pluginId &&
            publication.packageDigest === grant.packageDigest,
        ),
    )
  )
    invalid("task_publication");
  const references = [
    settings.taskPolicyAuthority,
    settings.uiPolicyAuthority,
    settings.packageAuthority,
    settings.quoteAuthority,
  ];
  const tokens: Record<string, string> = {};
  try {
    for (const { serviceTokenEnvironmentVariable: name } of references) {
      const shared = secretDescriptor(input.sharedEnvironment, name);
      const worker = secretDescriptor(input.workerEnvironment, name);
      if (shared !== undefined && worker !== undefined && shared !== worker)
        invalid("task_authority_token_conflict");
      const token = shared ?? worker;
      if (typeof token !== "string" || !/^[\x21-\x7e]{32,8192}$/u.test(token))
        invalid("task_authority_token");
      tokens[name] = token;
    }
  } catch (error) {
    for (const name of Object.keys(tokens)) delete tokens[name];
    throw error;
  }
  const environmentNames = Object.freeze(Object.keys(tokens));
  let files: DesktopInstalledPluginTaskFiles | null = null;
  let activationOwner: DesktopInstalledPluginActivationFiles | null = null;
  let withdrawn = false;
  const assertCurrent = () => {
    if (withdrawn) invalid("withdrawn");
    assertDesktopInstalledPluginRuntimeConfiguration(
      configuration,
      dataDirectory,
    );
    if (
      desktopInstalledPluginTaskExecutionSettings(configuration) !== settings ||
      assertDesktopPluginBootstrapIssued(bootstrap) !== manifest
    )
      invalid("task_owner_changed");
    files?.assertCurrent();
  };
  const project = (
    environment: NodeJS.ProcessEnv,
    workerAuthorityTokens: Readonly<Record<string, string>> = {},
  ): NodeJS.ProcessEnv => {
    assertCurrent();
    const result = copyEnvironment(environment);
    delete result[TASK_PATH];
    for (const name of environmentNames) {
      if (Object.hasOwn(workerAuthorityTokens, name)) {
        const descriptor = Object.getOwnPropertyDescriptor(
          workerAuthorityTokens,
          name,
        );
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.value !== tokens[name] ||
          result[name] !== descriptor.value
        )
          invalid("task_worker_token_conflict");
      } else delete result[name];
    }
    return result;
  };
  const result: DesktopInstalledPluginTaskRuntimePublication = {
    environmentNames,
    project,
    controlAfterPeer(environment, activationFiles) {
      assertCurrent();
      const control = project(environment);
      if (activationOwner !== null && activationOwner !== activationFiles)
        invalid("task_activation_owner_changed");
      if (files === null) {
        files = createDesktopInstalledPluginTaskFiles({
          configuration,
          bootstrap,
          activationFiles,
          dataDirectory,
        });
        activationOwner = activationFiles;
      }
      assertCurrent();
      return Object.freeze({ ...control, ...tokens, [TASK_PATH]: files.path });
    },
    assertCurrent,
    withdraw() {
      withdrawn = true;
      files?.withdraw();
    },
    close() {
      withdrawn = true;
      files?.withdraw();
      try {
        files?.close();
      } finally {
        for (const name of environmentNames) delete tokens[name];
      }
    },
  };
  Object.defineProperties(result, {
    toJSON: {
      value: () => ({ environmentNames, withdrawn, tokens: "[REDACTED]" }),
    },
    [inspect.custom]: {
      value: () => "[DesktopInstalledPluginTaskRuntimePublication]",
    },
  });
  try {
    assertCurrent();
    return Object.freeze(result);
  } catch (error) {
    try {
      result.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "desktop_installed_plugin_task_capture_cleanup_failed",
      );
    }
    throw error;
  }
}

function secretDescriptor(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = Object.getOwnPropertyDescriptor(environment, name);
  if (value === undefined) return undefined;
  if (
    !value.enumerable ||
    !("value" in value) ||
    (value.value !== undefined && typeof value.value !== "string")
  )
    invalid("task_authority_token");
  return value.value;
}
function copyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = record(environment);
  if (
    Object.values(result).some(
      (value) => value !== undefined && typeof value !== "string",
    )
  )
    invalid("environment");
  return result as NodeJS.ProcessEnv;
}

/** Retires independent owned files after the parent has joined consumers; a peer failure cannot skip either owner. */
export function closeDesktopInstalledPluginRuntimePublicationFiles(
  input: Readonly<{
    tasks: DesktopInstalledPluginTaskRuntimePublication | null;
    activation: DesktopInstalledPluginActivationFiles | null;
  }>,
): void {
  if (input.tasks === null) {
    input.activation?.close();
    return;
  }
  const failures: unknown[] = [];
  for (const action of [
    () => input.tasks?.close(),
    () => input.activation?.close(),
  ]) {
    try {
      action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "desktop_installed_plugin_publication_cleanup_failed",
    );
}

/** Constructor failure cannot leak a captured owner or skip cleanup because a sibling cleanup failed. */
export function failDesktopInstalledPluginTaskPublicationCapture(
  input: Readonly<{
    error: unknown;
    tasks: DesktopInstalledPluginTaskRuntimePublication | null;
    shared: NodeJS.ProcessEnv;
    worker: NodeJS.ProcessEnv;
    authorityTokens: Record<string, string>;
    activationTokens: Record<string, string>;
    cleanup?(): void;
  }>,
): never {
  const names = [
    ...Object.keys(input.authorityTokens),
    ...Object.keys(input.activationTokens),
    ...(input.tasks?.environmentNames ?? []),
  ];
  const failures: unknown[] = [];
  try {
    for (const action of [
      () => input.cleanup?.(),
      () => input.tasks?.close(),
    ]) {
      try {
        action();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    for (const name of names) {
      delete input.authorityTokens[name];
      delete input.activationTokens[name];
      delete input.shared[name];
      delete input.worker[name];
    }
  }
  if (failures.length)
    throw new AggregateError(
      [input.error, ...failures],
      "desktop_installed_plugin_task_capture_cleanup_failed",
    );
  throw input.error;
}
