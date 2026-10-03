import { inspect, isDeepStrictEqual } from "node:util";
import {
  captureDesktopInstalledPluginRuntimeInputs,
  captureDesktopInstalledPluginAuthorityTokens,
  prepareDesktopInstalledPluginRuntime,
  withoutDesktopInstalledPluginEnvironment,
  type DesktopInstalledPluginRuntime,
  type DesktopInstalledPluginRuntimeInput,
} from "./desktopInstalledPluginRuntime.ts";
import {
  DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  assertDesktopInstalledPluginRuntimeConfiguration,
  createAutomaticDesktopInstalledPluginRuntimeFiles,
  captureDesktopInstalledPluginRuntimeDocument,
  desktopInstalledPluginAuthorityEndpoints,
  desktopInstalledPluginInvalid as invalid,
  desktopInstalledPluginRecord as record,
  type EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { assertDesktopPluginBootstrapIssued } from "./desktopPluginBootstrap.ts";

const PREPARATION_PATH = "CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH";
export type AutomaticDesktopInstalledPluginRuntime = Readonly<{
  preparationEnvironment: Readonly<NodeJS.ProcessEnv>;
  assertCurrent(): void;
  withdraw(): void;
  /** After the preparation child has physically closed; this does not publish or activate. */
  complete(): DesktopInstalledPluginRuntime;
  /** Caller has joined preparation, publication, challenge and all consuming children. */
  close(): Promise<void>;
}>;

export function prepareAutomaticDesktopInstalledPluginRuntime(
  input: Omit<DesktopInstalledPluginRuntimeInput, "configuration"> &
    Readonly<{
      configuration: EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration;
    }>,
): AutomaticDesktopInstalledPluginRuntime {
  const captured = captureDesktopInstalledPluginRuntimeInputs(input);
  const {
    dataDirectory,
    manifest,
    provider,
    bootstrap,
    shared,
    worker,
    signal,
  } = captured;
  const configuration = input.configuration;
  if (
    configuration.schemaVersion !==
    DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA
  )
    invalid("configuration_mode");
  const deadlineMs = input.deadlineMs ?? 20_000;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1_000 ||
    deadlineMs > 30_000
  )
    invalid("deadline");
  const authorityTokens = captureDesktopInstalledPluginAuthorityTokens(
    {
      authorities: desktopInstalledPluginAuthorityEndpoints(
        configuration.workerAuthorities,
      ),
    },
    shared,
    worker,
  );
  const validationInput = Object.freeze({
    configuration,
    dataDirectory,
    bootstrap,
    provider: input.provider,
    sharedEnvironment: shared,
    workerEnvironment: worker,
    signal,
  });
  const files = createAutomaticDesktopInstalledPluginRuntimeFiles({
    configuration,
    dataDirectory,
    bootstrap,
  });
  let environment: NodeJS.ProcessEnv | null = {
    ...withoutDesktopInstalledPluginEnvironment(shared),
    ...authorityTokens,
    [PREPARATION_PATH]: files.preparationPath,
  };
  let runtime: DesktopInstalledPluginRuntime | null = null;
  let withdrawn = false;
  let closed = false;
  let closing: Promise<void> | null = null;
  const assertCurrent = () => {
    if (withdrawn || closed) invalid("withdrawn");
    signal.throwIfAborted();
    assertDesktopInstalledPluginRuntimeConfiguration(
      configuration,
      dataDirectory,
    );
    if (assertDesktopPluginBootstrapIssued(bootstrap) !== manifest)
      invalid("bootstrap_changed");
    const current = captureDesktopInstalledPluginRuntimeInputs(validationInput);
    if (!isDeepStrictEqual(current.provider, provider))
      invalid("provider_changed");
    files.assertCurrent();
    runtime?.assertCurrent();
    signal.throwIfAborted();
  };
  const withdraw = () => {
    withdrawn = true;
    files.withdraw();
    runtime?.withdraw();
  };
  signal.addEventListener("abort", withdraw, { once: true });
  const owner: AutomaticDesktopInstalledPluginRuntime = {
    get preparationEnvironment() {
      assertCurrent();
      return Object.freeze({ ...environment });
    },
    assertCurrent,
    withdraw,
    complete() {
      assertCurrent();
      if (runtime !== null) return runtime;
      try {
        const output = captureDesktopInstalledPluginRuntimeDocument(
          files.releasePath,
          1024 * 1024,
        );
        const document = record(output.value);
        if (
          !Array.isArray(document.entries) ||
          document.entries.length !== configuration.plugins.length
        )
          invalid("preparation_output");
        const seen = new Set<string>();
        for (const value of document.entries) {
          const entry = record(value);
          const identity = record(entry.packageIdentity);
          const selected = configuration.plugins.find(
            (plugin) => plugin.pluginId === identity.pluginId,
          );
          if (
            !selected ||
            seen.has(selected.pluginId) ||
            selected.approvalRequirement !== entry.approvalRequirement
          )
            invalid("preparation_output");
          seen.add(selected.pluginId);
        }
        runtime = prepareDesktopInstalledPluginRuntime({
          configuration: files.configuration,
          dataDirectory,
          bootstrap,
          provider,
          sharedEnvironment: shared,
          workerEnvironment: worker,
          signal,
          deadlineMs,
        });
        output.assertCurrent();
        assertCurrent();
        return runtime;
      } catch (error) {
        withdraw();
        throw error;
      }
    },
    close() {
      withdraw();
      if (closing !== null) return closing;
      closing = (async () => {
        await runtime?.close();
        files.close();
        signal.removeEventListener("abort", withdraw);
        environment = null;
        for (const name of Object.keys(authorityTokens)) {
          delete authorityTokens[name];
          delete shared[name];
          delete worker[name];
        }
        closed = true;
      })();
      void closing.catch(() => {
        closing = null;
      });
      return closing;
    },
  };
  Object.defineProperties(owner, {
    toJSON: {
      value: () => ({
        schemaVersion: DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        scope: manifest.scope,
        withdrawn,
      }),
    },
    [inspect.custom]: {
      value: () => "[AutomaticDesktopInstalledPluginRuntime]",
    },
  });
  try {
    assertCurrent();
    return Object.freeze(owner);
  } catch (error) {
    withdraw();
    signal.removeEventListener("abort", withdraw);
    files.close();
    throw error;
  }
}
