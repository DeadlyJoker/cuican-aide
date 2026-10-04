import { inspect, isDeepStrictEqual } from "node:util";
import {
  parseNativeInstalledPluginPreparationResult,
  NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_MAX_BYTES,
  type NativeInstalledPluginPreparationStatus,
} from "@crewon/contracts/plugins";
import {
  captureDesktopInstalledPluginRuntimeInputs,
  captureDesktopInstalledPluginAuthorityTokens,
  prepareDesktopInstalledPluginRuntime,
  withoutDesktopInstalledPluginEnvironment,
  type DesktopInstalledPluginRuntime,
  type DesktopInstalledPluginRuntimeInput,
} from "./desktopInstalledPluginRuntime.ts";
import {
  assertDesktopInstalledPluginRuntimeConfiguration,
  createAutomaticDesktopInstalledPluginRuntimeFiles,
  captureDesktopInstalledPluginRuntimeDocument,
  desktopInstalledPluginAuthorityEndpoints,
  desktopInstalledPluginActivationAuthority,
  isAutomaticDesktopInstalledPluginRuntimeConfiguration,
  desktopInstalledPluginInvalid as invalid,
  desktopInstalledPluginRecord as record,
  type EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { assertDesktopPluginBootstrapIssued } from "./desktopPluginBootstrap.ts";
import {
  captureDesktopInstalledPluginTaskRuntimePublication,
  failDesktopInstalledPluginTaskPublicationCapture,
} from "./desktopInstalledPluginTaskRuntimePublication.ts";

const PREPARATION_PATH = "CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH";
export type AutomaticDesktopInstalledPluginRuntimeCompletion =
  | Readonly<{
      kind: "installed";
      runtime: DesktopInstalledPluginRuntime;
      statuses: readonly NativeInstalledPluginPreparationStatus[];
    }>
  | Readonly<{
      kind: "default";
      environments: Readonly<{
        sharedEnvironment: Readonly<NodeJS.ProcessEnv>;
        workerEnvironment: Readonly<NodeJS.ProcessEnv>;
      }>;
      statuses: readonly NativeInstalledPluginPreparationStatus[];
    }>;
export type AutomaticDesktopInstalledPluginRuntime = Readonly<{
  preparationEnvironment: Readonly<NodeJS.ProcessEnv>;
  assertCurrent(): void;
  withdraw(): void;
  /** After the preparation child has physically closed; this does not publish or activate. */
  complete(): AutomaticDesktopInstalledPluginRuntimeCompletion;
  /** Caller has joined preparation, publication, challenge and all consuming children. */
  close(): Promise<void>;
}>;

function freezeCompletion(
  value: AutomaticDesktopInstalledPluginRuntimeCompletion,
) {
  Object.defineProperties(value, {
    toJSON: { value: () => ({ kind: value.kind, statuses: value.statuses }) },
    [inspect.custom]: {
      value: () =>
        `[AutomaticDesktopInstalledPluginRuntimeCompletion:${value.kind}]`,
    },
  });
  return Object.freeze(value);
}

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
  if (!isAutomaticDesktopInstalledPluginRuntimeConfiguration(configuration))
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
  const activationAuthority =
    desktopInstalledPluginActivationAuthority(configuration);
  const activationTokens: Record<string, string> =
    activationAuthority === null
      ? {}
      : captureDesktopInstalledPluginAuthorityTokens(
          {
            authorities: [
              {
                url: activationAuthority.url,
                environmentVariable:
                  activationAuthority.serviceTokenEnvironmentVariable,
              },
            ],
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
  const taskPublication = captureDesktopInstalledPluginTaskRuntimePublication({
    configuration,
    dataDirectory,
    bootstrap,
    sharedEnvironment: shared,
    workerEnvironment: worker,
  });
  let files: ReturnType<
    typeof createAutomaticDesktopInstalledPluginRuntimeFiles
  >;
  try {
    files = createAutomaticDesktopInstalledPluginRuntimeFiles({
      configuration,
      dataDirectory,
      bootstrap,
    });
  } catch (error) {
    failDesktopInstalledPluginTaskPublicationCapture({
      error,
      tasks: taskPublication,
      shared,
      worker,
      authorityTokens,
      activationTokens,
    });
  }
  let environment: NodeJS.ProcessEnv | null = {
    ...withoutDesktopInstalledPluginEnvironment(shared),
    ...authorityTokens,
    [PREPARATION_PATH]: files.preparationPath,
  };
  for (const name of Object.keys(activationTokens))
    if (!Object.hasOwn(authorityTokens, name)) delete environment[name];
  try {
    if (taskPublication !== null)
      environment = taskPublication.project(environment, authorityTokens);
  } catch (error) {
    failDesktopInstalledPluginTaskPublicationCapture({
      error,
      tasks: taskPublication,
      shared,
      worker,
      authorityTokens,
      activationTokens,
      cleanup: () => files.close(),
    });
  }
  let runtime: DesktopInstalledPluginRuntime | null = null;
  let completed: AutomaticDesktopInstalledPluginRuntimeCompletion | null = null;
  let resultFile: ReturnType<
    typeof captureDesktopInstalledPluginRuntimeDocument
  > | null = null;
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
    resultFile?.assertCurrent();
    if (completed?.kind === "default") files.assertReleaseAbsent();
    runtime?.assertCurrent();
    taskPublication?.assertCurrent();
    signal.throwIfAborted();
  };
  const withdraw = () => {
    withdrawn = true;
    files.withdraw();
    runtime?.withdraw();
    taskPublication?.withdraw();
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
      if (completed !== null) return completed;
      try {
        resultFile = captureDesktopInstalledPluginRuntimeDocument(
          files.resultPath,
          NATIVE_INSTALLED_PLUGIN_PREPARATION_RESULT_MAX_BYTES,
        );
        const result = parseNativeInstalledPluginPreparationResult(
          resultFile.value,
        );
        if (
          !isDeepStrictEqual(result.actor, manifest.actor) ||
          !isDeepStrictEqual(result.scope, manifest.scope) ||
          result.defaultAgentVersionId !== shared.CREWON_AGENT_VERSION_ID ||
          result.plugins.length !== configuration.plugins.length ||
          result.plugins.some(
            (status, index) =>
              status.pluginId !== configuration.plugins[index]!.pluginId ||
              (status.state === "prepared" &&
                status.approvalRequirement !==
                  configuration.plugins[index]!.approvalRequirement),
          )
        )
          invalid("preparation_result");
        const prepared = result.plugins.filter(
          (status) => status.state === "prepared",
        );
        if (prepared.length === 0) {
          files.assertReleaseAbsent();
          const defaultEnvironment = (input: NodeJS.ProcessEnv) => {
            const values = withoutDesktopInstalledPluginEnvironment(input);
            const environment = taskPublication?.project(values) ?? values;
            for (const name of [
              ...Object.keys(authorityTokens),
              ...Object.keys(activationTokens),
            ])
              delete environment[name];
            return Object.freeze(environment);
          };
          const defaultShared = defaultEnvironment(shared),
            defaultWorker = defaultEnvironment(worker);
          completed = freezeCompletion({
            kind: "default" as const,
            get environments() {
              assertCurrent();
              return Object.freeze({
                sharedEnvironment: Object.freeze({ ...defaultShared }),
                workerEnvironment: Object.freeze({ ...defaultWorker }),
              });
            },
            statuses: result.plugins,
          });
          assertCurrent();
          return completed;
        }
        const output = captureDesktopInstalledPluginRuntimeDocument(
          files.releasePath,
          1024 * 1024,
        );
        const document = record(output.value);
        if (
          !Array.isArray(document.entries) ||
          document.entries.length !== prepared.length
        )
          invalid("preparation_output");
        const seen = new Set<string>();
        for (const value of document.entries) {
          const entry = record(value);
          const identity = record(entry.packageIdentity);
          const selected = prepared.find(
            (status) => status.pluginId === identity.pluginId,
          );
          const config = record(entry.configuration);
          if (
            !selected ||
            seen.has(selected.pluginId) ||
            selected.approvalRequirement !== entry.approvalRequirement ||
            !isDeepStrictEqual(selected.packageIdentity, identity) ||
            !isDeepStrictEqual(selected.configuration, {
              revision: config.revision,
              contentDigest: config.contentDigest,
            }) ||
            !isDeepStrictEqual(selected.target, entry.target)
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
        completed = freezeCompletion({
          kind: "installed",
          runtime,
          statuses: result.plugins,
        });
        assertCurrent();
        return completed;
      } catch (error) {
        withdraw();
        throw error;
      }
    },
    close() {
      withdraw();
      if (closing !== null) return closing;
      closing = (async () => {
        const failures: unknown[] = [];
        try {
          if (taskPublication === null) {
            await runtime?.close();
            files.close();
          } else {
            for (const action of [
              () => runtime?.close(),
              () => taskPublication.close(),
              () => files.close(),
            ]) {
              try {
                await action();
              } catch (error) {
                failures.push(error);
              }
            }
          }
        } finally {
          signal.removeEventListener("abort", withdraw);
          environment = null;
          for (const name of [
            ...Object.keys(authorityTokens),
            ...Object.keys(activationTokens),
            ...(taskPublication?.environmentNames ?? []),
          ]) {
            delete authorityTokens[name];
            delete activationTokens[name];
            delete shared[name];
            delete worker[name];
          }
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            "desktop_installed_plugin_preparation_cleanup_failed",
          );
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
        schemaVersion: configuration.schemaVersion,
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
    failDesktopInstalledPluginTaskPublicationCapture({
      error,
      tasks: taskPublication,
      shared,
      worker,
      authorityTokens,
      activationTokens,
      cleanup: () => files.close(),
    });
  }
}
