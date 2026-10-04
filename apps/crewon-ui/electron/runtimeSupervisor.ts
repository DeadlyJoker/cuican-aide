import { writeDesktopConfigAtomically } from "./desktopConfigFile.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";

import type {
  ActiveProvider,
  ProviderRuntimeCredentialInput,
  ProviderRuntimeCredentialResolution,
} from "./providerCredentials.ts";
import {
  RuntimeLogForwarder,
  forwardRuntimeChildLogs,
  type RuntimeLogSink,
} from "./runtimeLogForwarder.ts";
import { processRuntimeLogs } from "./processRuntimeLogs.ts";
import {
  clearDesktopExtensionEnvironment,
  DESKTOP_RUNTIME_OWNER,
  desktopExtensionRuntimeEnvironments,
  parseDesktopExtensionRuntimeConfiguration,
  startDesktopRuntimeChildren,
  settleDesktopRuntimeChildren,
  type DesktopExtensionRuntimeConfiguration,
} from "./desktopExtensionRuntime.ts";
import {
  completeDesktopExtensionRecovery,
  desktopExtensionRecoveryAttempt,
  loadDesktopExtensionRecovery,
} from "./desktopExtensionRecovery.ts";
import { DesktopExtensionHistoryCoordinator } from "./desktopExtensionHistoryCoordinator.ts";
import { prepareDesktopExtensionCurrentUpgradeInputs } from "./desktopExtensionCurrentUpgradeInputs.ts";
import type { DesktopCurrentRuntimeChildren } from "./desktopControlRuntime.ts";
import {
  clearDesktopPluginEnvironment,
  DesktopPluginBootstrapOwner,
  DesktopLocalManagementAccessEvents,
  desktopPluginManagementEnvironment,
  type DesktopLocalManagementAccess,
} from "./desktopPluginManagementRuntime.ts";
import {
  isRuntimeChildTerminal,
  observeRuntimeChildClose,
  waitForRuntimeChildTerminalBefore,
} from "./runtimeChildClose.ts";
import {
  prepareDesktopInstalledPluginRuntime,
  clearDesktopInstalledPluginActivationEnvironment,
  type DesktopInstalledPluginRuntime,
} from "./desktopInstalledPluginRuntime.ts";
import type { DesktopInstalledPluginRuntimeConfiguration } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { startDesktopInstalledPluginRuntimeChildren } from "./desktopInstalledPluginRuntimeChildren.ts";
import {
  prepareAutomaticDesktopInstalledPluginRuntime,
  type AutomaticDesktopInstalledPluginRuntime,
} from "./desktopAutomaticInstalledPluginRuntime.ts";
import { isAutomaticDesktopInstalledPluginRuntimeConfiguration } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  captureDesktopPluginCreditSettlementEnvironment,
  type DesktopPluginCreditSettlementEnvironment,
} from "./desktopPluginCreditSettlementEnvironment.ts";

const MODEL_CATALOG_CACHE_FILE = "desktop-model-catalog-cache.json";
const MODEL_CATALOG_CACHE_SCHEMA = "crewon.desktop-model-catalog-cache.v1";
const MAX_CACHED_MODELS = 32;
const MAX_RUNTIME_MODELS = 24;
const MAX_MODEL_ID_BYTES = 256;
const RUNTIME_CHILD_GRACEFUL_EXIT_MS = 2_000;
const RUNTIME_CHILD_FORCED_EXIT_MS = 1_000;
const RUNTIME_ONCE_DEADLINE_MS = 60_000;
const NON_AGENT_MODEL_MARKERS = [
  "dall-e",
  "embedding",
  "gpt-image",
  "moderation",
  "speech",
  "transcribe",
  "tts",
  "whisper",
] as const;

export type RuntimePaths = Readonly<{
  control: string;
  modelCatalog: string;
  release: string;
  worker: string;
  workspaceMcp: string;
  source: boolean;
}>;

export type ControlRuntimeSession = Readonly<{
  baseUrl: string;
  csrfToken: string;
  origin: string;
  sessionToken: string;
}>;

export type CloudAgentProfile = Readonly<{
  agentVersionId: string;
  /** Provider-owned prompt snapshot used only to version the binding identity. */
  instructions: string;
  invocationUrl: string;
  modelId: string;
  agentId: number;
}>;

export class RuntimeSupervisor {
  readonly #dataDirectory: string;
  readonly #paths: RuntimePaths;
  readonly #repositoryRoot: string | null;
  readonly #origin = "http://crewon.localhost";
  readonly #sessionToken = randomBytes(32).toString("hex");
  readonly #csrfToken = randomBytes(32).toString("hex");
  readonly #probeToken = randomBytes(32).toString("hex");
  readonly #provider: () => ActiveProvider | null;
  readonly #providerModelCatalog: (
    provider: ActiveProvider,
  ) => Promise<readonly string[] | null>;
  readonly #agentPlatformApiKeyForOrigin: (origin: string) => string | null;
  readonly #workspaceRoot: () => string | null;
  readonly #extensionRuntime:
    | (() => DesktopExtensionRuntimeConfiguration)
    | undefined;
  readonly #extensionDeadlineMs: number | undefined;
  readonly #installedRuntime:
    | (() => DesktopInstalledPluginRuntimeConfiguration)
    | undefined;
  readonly #installedDeadlineMs: number | undefined;
  readonly #resolveExtensionCredential:
    | ((
        input: ProviderRuntimeCredentialInput,
      ) => ProviderRuntimeCredentialResolution)
    | undefined;
  #startupAbort: AbortController | null = null;
  #stopping: Promise<void> | null = null;
  #controlPort = 0;
  #probePort = 0;
  #children: ChildProcess[] = [];
  #currentChildren: DesktopCurrentRuntimeChildren | null = null;
  #managementControl: ChildProcess | null = null;
  #pluginBootstrap: DesktopPluginBootstrapOwner | null = null;
  #installedRuntimeOwner: DesktopInstalledPluginRuntime | null = null;
  #financialEnvironment: DesktopPluginCreditSettlementEnvironment | null = null;
  #automaticInstalledRuntimeOwner: AutomaticDesktopInstalledPluginRuntime | null =
    null;
  #installedStartupJoin: Promise<
    Readonly<{ control: ChildProcess; worker: ChildProcess }>
  > | null = null;
  readonly #localManagementEvents = new DesktopLocalManagementAccessEvents();
  #runtimeAbort: AbortController | null = null;
  #history: DesktopExtensionHistoryCoordinator | null = null;
  #restart: Promise<void> = Promise.resolve();
  #ready = false;
  #sessionGeneration = 0;
  readonly #sessionInvalidationListeners = new Set<
    () => void | Promise<void>
  >();
  readonly #sessionCleanup = new Set<Promise<void>>();
  #stopWatchingChildren: (() => void) | null = null;
  #cloudAgentProfiles: readonly CloudAgentProfile[] = [];
  readonly #logs: RuntimeLogSink;

  constructor(options: {
    dataDirectory: string;
    paths: RuntimePaths;
    repositoryRoot: string | null;
    provider: () => ActiveProvider | null;
    providerModelCatalog: (
      provider: ActiveProvider,
    ) => Promise<readonly string[] | null>;
    agentPlatformApiKeyForOrigin: (origin: string) => string | null;
    workspaceRoot: () => string | null;
    extensionRuntime?: Readonly<{
      configuration: () => DesktopExtensionRuntimeConfiguration;
      deadlineMs?: number;
      resolveProviderCredential?: (
        input: ProviderRuntimeCredentialInput,
      ) => ProviderRuntimeCredentialResolution;
    }>;
    installedRuntime?: Readonly<{
      configuration: () => DesktopInstalledPluginRuntimeConfiguration;
      deadlineMs?: number;
    }>;
    logOutputs?: { stdout: Writable; stderr: Writable };
  }) {
    this.#dataDirectory = options.dataDirectory;
    this.#paths = options.paths;
    this.#repositoryRoot = options.repositoryRoot;
    this.#provider = options.provider;
    this.#providerModelCatalog = options.providerModelCatalog;
    this.#agentPlatformApiKeyForOrigin = options.agentPlatformApiKeyForOrigin;
    this.#workspaceRoot = options.workspaceRoot;
    this.#extensionRuntime = options.extensionRuntime?.configuration;
    this.#extensionDeadlineMs = options.extensionRuntime?.deadlineMs;
    this.#installedRuntime = options.installedRuntime?.configuration;
    this.#installedDeadlineMs = options.installedRuntime?.deadlineMs;
    this.#resolveExtensionCredential =
      options.extensionRuntime?.resolveProviderCredential;
    this.#logs = options.logOutputs
      ? new RuntimeLogForwarder(options.logOutputs)
      : processRuntimeLogs();
  }

  async start(): Promise<void> {
    if (this.#stopping !== null) await this.#stopping;
    if (this.#children.length > 0 || this.#startupAbort !== null) return;
    if (this.#pluginBootstrap !== null)
      throw new Error("desktop_plugin_bootstrap_cleanup_required");
    if (this.#installedRuntimeOwner !== null)
      throw new Error("desktop_installed_plugin_runtime_cleanup_required");
    if (this.#automaticInstalledRuntimeOwner !== null)
      throw new Error("desktop_installed_plugin_preparation_cleanup_required");
    const configuration =
      this.#extensionRuntime?.() ??
      parseDesktopExtensionRuntimeConfiguration({
        schemaVersion: "crewon.desktop-extension-runtime.v0",
        enabled: false,
      });
    this.#logs.resume();
    const provider = this.#provider();
    const startup = new AbortController();
    this.#startupAbort = startup;
    this.#runtimeAbort = startup;
    try {
      this.#financialEnvironment =
        captureDesktopPluginCreditSettlementEnvironment(process.env);
      const bootstrapOwner = new DesktopPluginBootstrapOwner({
        dataDirectory: this.#dataDirectory,
        actor: DESKTOP_RUNTIME_OWNER,
        sessionEntropy: `${this.#sessionToken}:${this.#sessionGeneration}`,
      });
      this.#pluginBootstrap = bootstrapOwner;
      const bootstrap = await bootstrapOwner.prepared();
      startup.signal.throwIfAborted();
      if (provider === null && bootstrap === null) {
        await bootstrapOwner.close();
        startup.signal.throwIfAborted();
        if (this.#pluginBootstrap === bootstrapOwner)
          this.#pluginBootstrap = null;
        if (this.#runtimeAbort === startup) this.#runtimeAbort = null;
        this.#financialEnvironment.close();
        this.#financialEnvironment = null;
        this.#ready = false;
        return;
      }
      this.#controlPort ||= await freePort();
      startup.signal.throwIfAborted();
      ensureStorage(this.#dataDirectory);
      if (provider === null) {
        const control = this.#spawnControl(
          desktopPluginManagementEnvironment({
            ambient: process.env,
            dataDirectory: this.#dataDirectory,
            controlPort: this.#controlPort,
            origin: this.#origin,
            csrfToken: this.#csrfToken,
            sessionToken: this.#sessionToken,
          }),
        );
        this.#children.push(control);
        this.#managementControl = control;
        await waitForReady(
          `http://127.0.0.1:${this.#controlPort}/api/v1/health/live`,
          [control],
          startup.signal,
        );
        startup.signal.throwIfAborted();
        this.#ready = true;
        this.#localManagementEvents.notify();
        this.#watchCurrentChildren();
        return;
      }
      this.#probePort ||= await freePort();
      startup.signal.throwIfAborted();
      const modelCatalog = await this.#resolveModelCatalog(provider);
      startup.signal.throwIfAborted();
      const agentPlatformApiKey =
        this.#cloudAgentProfiles.length === 0
          ? null
          : this.#agentPlatformApiKeyForOrigin(
              cloudAgentProfilesOrigin(this.#cloudAgentProfiles),
            );
      const environment = this.#environment(
        provider,
        modelCatalog,
        agentPlatformApiKey === null ? [] : this.#cloudAgentProfiles,
      );
      let { sharedEnvironment, workerEnvironment } =
        agentPlatformRuntimeEnvironments(environment, agentPlatformApiKey);
      let assertPreparedDefaultCurrent: (() => void) | undefined;
      const installedConfiguration = this.#installedRuntime?.();
      if (installedConfiguration?.enabled) {
        const expectedProvider = { ...provider };
        const assertProviderCurrent = () => {
          const current = this.#provider();
          if (
            current === null ||
            (["providerId", "endpoint", "modelId", "apiKey"] as const).some(
              (field) => current[field] !== expectedProvider[field],
            )
          )
            throw new Error("desktop_installed_plugin_provider_changed");
        };
        assertProviderCurrent();
        if (configuration.enabled)
          throw new Error("desktop_installed_plugin_legacy_runtime_conflict");
        if (bootstrap === null)
          throw new Error("desktop_installed_plugin_bootstrap_required");
        const installedInputs = {
          dataDirectory: this.#dataDirectory,
          bootstrap,
          provider,
          sharedEnvironment: {
            ...sharedEnvironment,
            CREWON_MODEL_CREDENTIAL_REQUIRED:
              provider.apiKey === null ? "0" : "1",
          },
          workerEnvironment: {
            ...workerEnvironment,
            CREWON_MODEL_CREDENTIAL_REQUIRED:
              provider.apiKey === null ? "0" : "1",
          },
          deadlineMs: this.#installedDeadlineMs,
          signal: startup.signal,
        };
        let installed: DesktopInstalledPluginRuntime | null = null;
        if (
          isAutomaticDesktopInstalledPluginRuntimeConfiguration(
            installedConfiguration,
          )
        ) {
          const automatic = prepareAutomaticDesktopInstalledPluginRuntime({
            ...installedInputs,
            configuration: installedConfiguration,
          });
          this.#automaticInstalledRuntimeOwner = automatic;
          automatic.assertCurrent();
          await this.#runOnce(
            "Installed plugin preparation",
            this.#paths.release,
            automatic.preparationEnvironment,
            startup.signal,
          );
          assertProviderCurrent();
          automatic.assertCurrent();
          startup.signal.throwIfAborted();
          const completed = automatic.complete();
          for (const status of completed.statuses) {
            if (status.state === "blocked")
              this.#logs.write(
                "stderr",
                "Installed plugin preparation",
                `${status.pluginId}:${status.reasonCode}\n`,
              );
          }
          if (completed.kind === "installed") {
            installed = completed.runtime;
          } else {
            ({ sharedEnvironment, workerEnvironment } = completed.environments);
            assertPreparedDefaultCurrent = () => {
              assertProviderCurrent();
              automatic.assertCurrent();
            };
          }
        } else {
          installed = prepareDesktopInstalledPluginRuntime({
            ...installedInputs,
            configuration: installedConfiguration,
          });
        }
        if (installed !== null) {
          const installedRuntime = installed;
          this.#installedRuntimeOwner = installedRuntime;
          installed.assertCurrent();
          await this.#runOnce(
            "Runtime release",
            this.#paths.release,
            installed.release,
            startup.signal,
          );
          assertProviderCurrent();
          installed.assertCurrent();
          startup.signal.throwIfAborted();
          // Register before invoking an asynchronous child/challenge operation.
          // stop() joins this physical work after withdrawing and stopping children.
          const startingChildren = Promise.resolve().then(() =>
            startDesktopInstalledPluginRuntimeChildren({
              runtime: installedRuntime,
              signal: startup.signal,
              deadlineMs: this.#installedDeadlineMs,
              spawnControl: (env) => this.#spawnControl(env),
              spawnWorker: (env) =>
                this.#spawn("Runtime Worker", this.#paths.worker, env, {
                  stdin: "pipe",
                  financialRole: "worker",
                }),
              trackChild: (child) => this.#children.push(child),
            }),
          );
          this.#installedStartupJoin = startingChildren;
          let control: ChildProcess, worker: ChildProcess;
          try {
            ({ control, worker } = await startingChildren);
          } finally {
            if (this.#installedStartupJoin === startingChildren)
              this.#installedStartupJoin = null;
          }
          this.#currentChildren = { control, worker };
          await waitForReady(
            `http://127.0.0.1:${this.#controlPort}/api/v1/health/ready`,
            [control, worker],
            startup.signal,
          );
          assertProviderCurrent();
          installed.assertCurrent();
          startup.signal.throwIfAborted();
          this.#ready = true;
          this.#localManagementEvents.notify();
          this.#watchCurrentChildren();
          return;
        }
      }
      assertPreparedDefaultCurrent?.();
      const initialExtensions = desktopExtensionRuntimeEnvironments({
        configuration,
        sharedEnvironment,
        workerEnvironment,
        deadlineMs: this.#extensionDeadlineMs,
        retainedBuild: this.#paths.source
          ? undefined
          : { dataRoot: this.#dataDirectory },
      });
      let currentEnvironments = initialExtensions;
      if (this.#resolveExtensionCredential) {
        const upgrade = await prepareDesktopExtensionCurrentUpgradeInputs({
          dataRoot: this.#dataDirectory,
          configuration,
          environments: initialExtensions,
          currentBuildDirectory: dirname(this.#paths.release),
          source: this.#paths.source,
          resolveProvider: this.#resolveExtensionCredential,
          signal: startup.signal,
        });
        startup.signal.throwIfAborted();
        currentEnvironments = upgrade.environments;
        if (upgrade.reasonCode !== null)
          this.#logs.write(
            "stderr",
            "Extension upgrade",
            `${upgrade.reasonCode}\n`,
          );
      }
      const recovery = desktopExtensionRecoveryAttempt({
        dataRoot: this.#dataDirectory,
        provider,
        source: this.#paths.source,
        environments: currentEnvironments,
      });
      let extensions = recovery.environments;
      startup.signal.throwIfAborted();
      assertPreparedDefaultCurrent?.();
      await this.#runOnce(
        "Runtime release",
        this.#paths.release,
        extensions.release,
        startup.signal,
      );
      startup.signal.throwIfAborted();
      assertPreparedDefaultCurrent?.();
      const prepared =
        recovery.attempt === null
          ? null
          : await loadDesktopExtensionRecovery({
              attempt: recovery.attempt,
              environments: extensions,
            });
      if (prepared !== null) extensions = prepared.environments;
      const { control, worker, extensionOrigin } =
        await startDesktopRuntimeChildren({
          environments: extensions,
          signal: startup.signal,
          spawnControl: (environment) => this.#spawnControl(environment),
          spawnWorker: (environment) =>
            this.#spawn("Runtime Worker", this.#paths.worker, environment, {
              stdin: "pipe",
              financialRole: "worker",
            }),
          trackChild: (child) => this.#children.push(child),
        });
      this.#currentChildren = { control, worker };
      await waitForReady(
        `http://127.0.0.1:${this.#controlPort}/api/v1/health/ready`,
        [control, worker],
        startup.signal,
      );
      startup.signal.throwIfAborted();
      let currentCapsuleId: string | null = null;
      if (prepared?.candidate && extensions.enabled && extensionOrigin) {
        const completed = await completeDesktopExtensionRecovery({
          dataRoot: this.#dataDirectory,
          manifest: prepared.candidate,
          origin: extensionOrigin,
          token: extensions.token,
          signal: startup.signal,
          deadlineMs: extensions.deadlineMs,
        });
        if (completed.outcome === "unavailable")
          this.#logs.write(
            "stderr",
            "Extension recovery",
            `${completed.reasonCode}\n`,
          );
        else currentCapsuleId = prepared.candidate.capsuleId;
      } else if (prepared?.reasonCode) {
        this.#logs.write(
          "stderr",
          "Extension recovery",
          `${prepared.reasonCode}\n`,
        );
      }
      startup.signal.throwIfAborted();
      assertPreparedDefaultCurrent?.();
      this.#ready = true;
      this.#localManagementEvents.notify();
      this.#watchCurrentChildren();
      if (
        extensions.enabled &&
        !this.#paths.source &&
        this.#resolveExtensionCredential &&
        extensionOrigin
      ) {
        this.#startHistoricalHosts({
          currentCapsuleId,
          controlEnvironment: extensions.control(extensionOrigin),
          startup,
        });
      }
    } catch (error) {
      if (this.#startupAbort === startup) await this.stop();
      throw error;
    } finally {
      if (this.#startupAbort === startup) this.#startupAbort = null;
    }
  }

  #watchCurrentChildren(
    options: Readonly<{ scope: "pair" | "worker" }> = { scope: "pair" },
  ): void {
    const children = this.#currentChildren;
    const managementControl = this.#managementControl;
    if (children === null && managementControl === null) return;
    this.#stopWatchingChildren?.();
    this.#stopWatchingChildren = watchRuntimeChildren(
      children === null
        ? [{ child: managementControl!, name: "Control API" }]
        : [
            ...(options.scope === "pair"
              ? [{ child: children.control, name: "Control API" }]
              : []),
            { child: children.worker, name: "Runtime Worker" },
          ],
      ({ code, name, signal }) => {
        this.#invalidateSession();
        this.#stopWatchingChildren?.();
        this.#stopWatchingChildren = null;
        this.#logs.write(
          "stderr",
          name,
          `exited unexpectedly (${signal ?? code ?? "unknown"}); restarting runtime\n`,
        );
        void this.restart().catch((error) => {
          this.#logs.write(
            "stderr",
            "Runtime restart",
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      },
    );
  }

  #startHistoricalHosts(input: {
    currentCapsuleId: string | null;
    controlEnvironment: NodeJS.ProcessEnv;
    startup: AbortController;
  }): void {
    const history = new DesktopExtensionHistoryCoordinator({
      dataRoot: this.#dataDirectory,
      currentCapsuleId: input.currentCapsuleId,
      controlEnvironment: input.controlEnvironment,
      signal: input.startup.signal,
      deadlineMs: this.#extensionDeadlineMs,
      resolveProvider: this.#resolveExtensionCredential!,
      spawnHistoricalWorker: (entry, environment) =>
        this.#spawn("Historical Runtime Worker", entry, environment, {
          stdin: "pipe",
        }),
      spawnControl: (environment) => this.#spawnControl(environment),
      terminate: terminateRuntimeChild,
      trackChild: (child) => this.#children.push(child),
      releaseChild: (child) => {
        this.#children = this.#children.filter((owned) => owned !== child);
      },
      isCurrent: () => this.#runtimeAbort === input.startup,
      currentChildren: () => this.#currentChildren,
      beginControlReplacement: async () => {
        this.#invalidateSession();
        const cleanup = await this.#settleSessionCleanup();
        if (cleanup.some((v) => v.status === "rejected"))
          throw new Error("native_session_cleanup_failed");
        this.#watchCurrentChildren({ scope: "worker" });
      },
      registerControlReplacement: (children) => {
        this.#currentChildren = children;
        this.#watchCurrentChildren();
      },
      restoreUnchangedControl: () => {
        const children = this.#currentChildren;
        if (
          children &&
          [children.control, children.worker].every(
            (child) => child.exitCode === null && child.signalCode === null,
          )
        )
          this.#ready = true;
        this.#localManagementEvents.notify();
        this.#watchCurrentChildren();
      },
      finishControlReplacement: (children) => {
        this.#currentChildren = children;
        this.#ready = true;
        this.#localManagementEvents.notify();
        this.#watchCurrentChildren();
      },
      waitForControlReady: (children, signal) =>
        waitForReady(
          `http://127.0.0.1:${this.#controlPort}/api/v1/health/ready`,
          children,
          signal,
        ),
      diagnostic: (reasonCode) =>
        this.#logs.write("stderr", "Extension history", `${reasonCode}\n`),
    });
    this.#history = history;
    history.start();
  }

  async restart(): Promise<void> {
    this.#restart = this.#restart
      .catch(() => {
        // A later retry must not remain blocked by an earlier failed restart.
      })
      .then(async () => {
        await this.stop();
        await this.start();
      });
    return this.#restart;
  }

  /** Updates cloud Agent profiles and restarts the runtime so they take effect. */
  async updateCloudAgentProfiles(
    profiles: readonly CloudAgentProfile[],
  ): Promise<void> {
    if (profiles.length > 0) {
      const origin = cloudAgentProfilesOrigin(profiles);
      if (this.#agentPlatformApiKeyForOrigin(origin) === null) {
        throw new Error("agent_platform_api_key_missing");
      }
    }
    this.#cloudAgentProfiles = profiles;
    await this.restart();
  }

  /** Applies key replacement or revocation to active profiles for one origin. */
  async agentPlatformCredentialChanged(origin: string): Promise<void> {
    if (
      this.#cloudAgentProfiles.length === 0 ||
      cloudAgentProfilesOrigin(this.#cloudAgentProfiles) !== origin
    ) {
      return;
    }
    await this.restart();
  }

  async stop(): Promise<void> {
    if (this.#stopping !== null) return this.#stopping;
    this.#invalidateSession();
    this.#startupAbort?.abort();
    this.#startupAbort = null;
    this.#runtimeAbort?.abort();
    this.#runtimeAbort = null;
    this.#pluginBootstrap?.withdraw();
    this.#installedRuntimeOwner?.withdraw();
    this.#automaticInstalledRuntimeOwner?.withdraw();
    this.#stopWatchingChildren?.();
    this.#stopWatchingChildren = null;
    const stopping = this.#stopOwnedRuntime();
    this.#stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopping === stopping) this.#stopping = null;
    }
  }

  async #stopOwnedRuntime(): Promise<void> {
    const history = this.#history;
    const bootstrap = this.#pluginBootstrap;
    const installed = this.#installedRuntimeOwner;
    const automatic = this.#automaticInstalledRuntimeOwner;
    const installedStartup = this.#installedStartupJoin;
    let nativeCleanup = await this.#settleSessionCleanup();
    const results = await Promise.allSettled([history?.stop()]);
    const childStops = await Promise.allSettled([
      this.#stopChildren([...this.#children]),
    ]);
    // Aborted startup may reject, but its actual HTTP/body work must finish
    // before retiring its captured owner and the Native bootstrap files.
    await Promise.allSettled([installedStartup]);
    const childFailures = childStops.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (childFailures.length > 0)
      throw new AggregateError(
        childFailures,
        "runtime_children_shutdown_failed",
      );
    if (nativeCleanup.some((v) => v.status === "rejected")) {
      // The actual managed Control may now be terminal. Reconcile its captured native owners,
      // while an uncertain local reader must continue to reject physical cleanup.
      this.#invalidateSession();
      nativeCleanup = await this.#settleSessionCleanup();
    }
    if (this.#children.length === 0) {
      this.#financialEnvironment?.close();
      this.#financialEnvironment = null;
      this.#currentChildren = null;
      this.#managementControl = null;
      this.#history = null;
      await installed?.close();
      if (this.#installedRuntimeOwner === installed)
        this.#installedRuntimeOwner = null;
      await automatic?.close();
      if (this.#automaticInstalledRuntimeOwner === automatic)
        this.#automaticInstalledRuntimeOwner = null;
      await bootstrap?.close();
      if (this.#pluginBootstrap === bootstrap) this.#pluginBootstrap = null;
      if (nativeCleanup.some((v) => v.status === "rejected"))
        throw new Error("native_session_cleanup_failed");
      return;
    }
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "runtime_children_shutdown_failed");
  }

  async #stopChildren(children: readonly ChildProcess[]): Promise<void> {
    try {
      const { terminal, failures } = await settleDesktopRuntimeChildren(
        children,
        terminateRuntimeChild,
      );
      this.#children = this.#children.filter((child) => !terminal.has(child));
      if (failures.length > 0)
        throw new AggregateError(failures, "runtime_children_shutdown_failed");
    } finally {
      this.#logs.suspend();
    }
  }

  /** Native ownership identity, separate from the public bootstrap/session DTO. */
  get sessionGeneration(): number {
    return this.#sessionGeneration;
  }

  /** Only this native runtime's approved owner and live authenticated Control can publish access. */
  localManagementAccess(): DesktopLocalManagementAccess | null {
    if (!this.#pluginBootstrap?.enabled) return null;
    try {
      this.session();
      return Object.freeze({
        schemaVersion: "crewon.desktop-local-management-access.v1",
        generation: this.#sessionGeneration,
      });
    } catch {
      return null;
    }
  }

  onLocalManagementAccessChanged(listener: () => void): () => void {
    return this.#localManagementEvents.subscribe(listener);
  }

  /** Native lifetime owner; never included in the renderer's bootstrap DTO. */
  currentControlOwner(): ChildProcess {
    this.session();
    return this.#managementControl ?? this.#currentChildren!.control;
  }

  onSessionInvalidated(listener: () => void | Promise<void>): () => void {
    this.#sessionInvalidationListeners.add(listener);
    return () => this.#sessionInvalidationListeners.delete(listener);
  }

  #invalidateSession(): void {
    this.#ready = false;
    this.#sessionGeneration++;
    this.#localManagementEvents.notify();
    for (const listener of this.#sessionInvalidationListeners) {
      try {
        const cleanup = Promise.resolve(listener());
        this.#sessionCleanup.add(cleanup);
        void cleanup.then(
          () => this.#sessionCleanup.delete(cleanup),
          () => {},
        );
      } catch {
        const failed = Promise.reject(
          new Error("native_session_cleanup_failed"),
        );
        this.#sessionCleanup.add(failed);
        void failed.catch(() => {});
      }
    }
  }

  async #settleSessionCleanup(): Promise<PromiseSettledResult<void>[]> {
    const results: PromiseSettledResult<void>[] = [];
    while (this.#sessionCleanup.size) {
      const pending = [...this.#sessionCleanup];
      results.push(...(await Promise.allSettled(pending)));
      for (const task of pending) this.#sessionCleanup.delete(task);
    }
    return results;
  }

  session(): ControlRuntimeSession {
    const current = this.#currentChildren;
    const children = this.#managementControl
      ? [this.#managementControl]
      : current
        ? [current.control, current.worker]
        : [];
    if (
      !this.#ready ||
      children.length === 0 ||
      children.some(
        (child) => child.exitCode !== null || child.signalCode !== null,
      )
    ) {
      this.#ready = false;
      throw new Error("control_runtime_unavailable");
    }
    return {
      baseUrl: `http://127.0.0.1:${this.#controlPort}/`,
      csrfToken: this.#csrfToken,
      origin: this.#origin,
      sessionToken: this.#sessionToken,
    };
  }

  logStatus() {
    return this.#logs.status();
  }

  async #resolveModelCatalog(
    provider: ActiveProvider,
  ): Promise<readonly string[]> {
    const cached = readModelCatalogCache(this.#dataDirectory, provider);
    let discovered: readonly string[] | null = null;
    try {
      discovered = await this.#providerModelCatalog(provider);
    } catch (error) {
      this.#logs.write(
        "stderr",
        "Model catalog",
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    const selected = selectDesktopRuntimeModelCatalog({
      cached,
      defaultModelId: provider.modelId,
      discovered,
    });
    if (
      discovered !== null &&
      JSON.stringify(selected) !== JSON.stringify(cached)
    ) {
      writeModelCatalogCache(this.#dataDirectory, provider, selected);
    }
    return selected;
  }

  #environment(
    provider: ActiveProvider,
    modelCatalog: readonly string[],
    cloudAgentProfiles: readonly CloudAgentProfile[],
  ): NodeJS.ProcessEnv {
    const agentProfiles = [
      {
        agentVersionIdSuffix: "planner",
        instructions:
          "你是本地规划智能体。先拆解约束、依赖和验收标准，再给出可执行计划。",
      },
      {
        agentVersionIdSuffix: "verifier",
        instructions:
          "你是本地独立验证智能体。逐项检查证据并明确通过、不通过或缺失证据。",
      },
    ] as const;
    const workspace = this.#workspaceRoot();
    const mcpConfig =
      workspace === null ? null : this.#writeMcpConfig(workspace);
    const fingerprint = desktopRuntimeFingerprint({
      providerId: provider.providerId,
      endpoint: provider.endpoint,
      modelId: provider.modelId,
      modelCatalog,
      agentProfiles,
      localWorkspaceMcp:
        mcpConfig === null
          ? null
          : {
              configPath: mcpConfig,
              configDigest: fileDigest(mcpConfig),
              serverDigest: fileDigest(this.#paths.workspaceMcp),
            },
    });
    const agentVersionId = `local-desktop-${fingerprint.slice(0, 24)}`;
    const devAgentProfiles = [
      ...agentProfiles.map((profile) => ({
        agentVersionId: `${agentVersionId}-${profile.agentVersionIdSuffix}`,
        instructions: profile.instructions,
      })),
      ...cloudAgentProfiles.map((profile) => ({
        agentVersionId: cloudAgentRuntimeVersionId(profile, fingerprint),
        instructions: profile.instructions,
        cloudAgent: {
          invocationUrl: profile.invocationUrl,
          modelId: profile.modelId,
          agentId: profile.agentId,
        },
      })),
    ];
    const environment: NodeJS.ProcessEnv = {
      ...clearDesktopPluginEnvironment(
        clearDesktopExtensionEnvironment(
          clearDesktopInstalledPluginActivationEnvironment(
            this.#financialEnvironment!.project(process.env, {
              role: "shared",
            }),
          ),
        ),
      ),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      CREWON_ACTOR_ID: DESKTOP_RUNTIME_OWNER.actorId,
      CREWON_AGENT_VERSION_ID: agentVersionId,
      CREWON_ARTIFACT_DB_PATH: join(
        this.#dataDirectory,
        "artifact-metadata.sqlite",
      ),
      CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "desktop-artifact-key-v1",
      CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: join(
        this.#dataDirectory,
        "artifact-encryption.key",
      ),
      CREWON_ARTIFACT_ROOT: join(this.#dataDirectory, "artifacts"),
      CREWON_AUTHORITY_ID: "standalone-authority",
      CREWON_CONTROL_ALLOWED_ORIGINS: this.#origin,
      CREWON_CONTROL_CSRF_TOKEN: this.#csrfToken,
      CREWON_CONTROL_DB_PATH: join(this.#dataDirectory, "control.sqlite"),
      CREWON_CONTROL_ORIGIN: this.#origin,
      CREWON_CONTROL_PORT: String(this.#controlPort),
      CREWON_CONTROL_SECURITY_MODE: "standalone",
      CREWON_CONTROL_SESSION_TOKEN: this.#sessionToken,
      CREWON_CONTROL_TARGET: `http://127.0.0.1:${this.#controlPort}`,
      CREWON_MODEL_ADAPTER: "responses",
      CREWON_MODEL_API_KEY: provider.apiKey ?? "",
      CREWON_MODEL_CATALOG_JSON: JSON.stringify(modelCatalog),
      CREWON_MODEL_ID: provider.modelId,
      CREWON_DEV_AGENT_PROFILES_JSON: JSON.stringify(devAgentProfiles),
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: join(
        this.#dataDirectory,
        "agent-version-runtime-bindings.json",
      ),
      CREWON_NATIVE_WORKSPACE_READ_ENABLED: "0",
      CREWON_POLICY_SNAPSHOT_ID: "standalone-policy-v0",
      CREWON_PRINCIPAL_ID: DESKTOP_RUNTIME_OWNER.principalId,
      CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT: "CREWON_MODEL_API_KEY",
      CREWON_PROVIDER_PROBE_ENDPOINT: provider.endpoint,
      CREWON_PROVIDER_PROBE_PORT: String(this.#probePort),
      CREWON_PROVIDER_PROBE_PROVIDER_ID: provider.providerId,
      CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID: `desktop-${fingerprint.slice(0, 32)}`,
      CREWON_PROVIDER_PROBE_TOKEN: this.#probeToken,
      CREWON_PROVIDER_PROBE_WORKER_ORIGIN: `http://127.0.0.1:${this.#probePort}`,
      CREWON_PROVIDER_PROBE_WORKER_TOKEN: this.#probeToken,
      CREWON_RELEASE_ACTOR_ID: DESKTOP_RUNTIME_OWNER.actorId,
      CREWON_RELEASE_PRINCIPAL_ID: DESKTOP_RUNTIME_OWNER.principalId,
      CREWON_RESPONSES_ENDPOINT: responsesEndpoint(provider.endpoint),
      CREWON_RUNTIME_GENERATION: `desktop-${fingerprint.slice(0, 32)}`,
      CREWON_SPACE_ID: DESKTOP_RUNTIME_OWNER.spaceId,
      CREWON_TENANT_ID: DESKTOP_RUNTIME_OWNER.tenantId,
    };
    bindDesktopWorkspaceEnvironment(environment, { mcpConfig, workspace });
    for (const name of [
      "CREWON_AGENT_PLATFORM_API_KEY",
      "CREWON_CONTROL_DATABASE_URL",
      "CREWON_CONTROL_DATABASE_SCHEMA",
      "CREWON_DEVICE_TOOL_CONFIG_PATH",
      "CREWON_NATIVE_WORKSPACE_BOOTSTRAP",
      "CREWON_PIM_SANDBOX_AGENT_ID",
      "CREWON_PIM_SANDBOX_BASE_URL",
      "CREWON_PIM_SANDBOX_PASSWORD",
      "CREWON_PIM_SANDBOX_USERNAME",
      "CREWON_WORKSPACE_RUNTIME_WORKER_ORIGIN",
      "CREWON_WORKSPACE_RUNTIME_WORKER_TOKEN",
    ]) {
      delete environment[name];
    }
    return environment;
  }

  #writeMcpConfig(workspace: string): string | null {
    const server = this.#paths.workspaceMcp;
    if (!existsSync(server)) return null;
    const path = join(this.#dataDirectory, "local-workspace-mcp.json");
    const readPolicy = {
      effect: "readOnly",
      recovery: "replaySafe",
      resourceBindingId: "local-workspace",
      credentialBindingId: null,
      executionTarget: { kind: "control", bindingId: "local-workspace" },
      capability: "workspace.read_only_command.v0",
      approvalRequirement: "none",
      limits: {
        timeoutMs: 125_000,
        maxOutputBytes: 64 * 1024,
        maxArtifactBytes: 1,
      },
    };
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schemaVersion: "crewon.mcp-stdio-config.v0",
          servers: [
            {
              serverId: "workspace_checks",
              command: process.execPath,
              args: [server],
              cwd: workspace,
              env: {
                ...pickEnvironment(["PATH"]),
                ELECTRON_RUN_AS_NODE: "1",
                CREWON_LOCAL_WORKSPACE_ROOT: workspace,
                CREWON_LOCAL_PNPM_PATH: executable("pnpm"),
                CREWON_LOCAL_GIT_PATH: executable("git"),
              },
              tools: {
                list_files: readPolicy,
                read_file: readPolicy,
                git_status: readPolicy,
                run_ui_test: readPolicy,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    return path;
  }

  #spawnControl(environment: NodeJS.ProcessEnv): ChildProcess {
    return this.#spawn(
      "Control API",
      this.#paths.control,
      this.#pluginBootstrap
        ? this.#pluginBootstrap.controlEnvironment(environment)
        : clearDesktopPluginEnvironment(environment),
    );
  }

  #spawn(
    name: string,
    entry: string,
    environment: NodeJS.ProcessEnv,
    options: Readonly<{ stdin?: "pipe"; financialRole?: "worker" }> = {},
  ): ChildProcess {
    if (this.#financialEnvironment === null)
      throw new Error("desktop_runtime_environment_unprepared");
    const projected = this.#financialEnvironment.project(environment, {
      role: options.financialRole ?? "shared",
    });
    const child = spawn(
      process.execPath,
      nodeArguments(entry, this.#paths.source),
      {
        cwd: this.#repositoryRoot ?? process.resourcesPath,
        env: projected,
        stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    observeRuntimeChildClose(child);
    forwardRuntimeChildLogs(child, name, this.#logs);
    return child;
  }

  async #runOnce(
    name: string,
    entry: string,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<void> {
    const child = this.#spawn(name, entry, environment);
    this.#children.push(child);
    try {
      const exit = await waitForRuntimeChildTerminalBefore(
        child,
        RUNTIME_ONCE_DEADLINE_MS,
      );
      signal.throwIfAborted();
      if (exit === null) {
        await terminateRuntimeChild(child);
        throw new Error(`${name} timed out`);
      }
      const { code, signal: exitSignal } = exit;
      if (code !== 0)
        throw new Error(`${name} failed (${exitSignal ?? code ?? "unknown"})`);
    } finally {
      const index = this.#children.indexOf(child);
      if (index !== -1 && isRuntimeChildTerminal(child))
        this.#children.splice(index, 1);
    }
  }
}

/** Gracefully stops a runtime child, then force-kills it without waiting forever. */
export async function terminateRuntimeChild(
  child: ChildProcess,
  options: Readonly<{
    forcedExitMs?: number;
    gracefulExitMs?: number;
  }> = {},
): Promise<void> {
  if (isRuntimeChildTerminal(child)) return;
  const gracefulExit = waitForRuntimeChildTerminalBefore(
    child,
    options.gracefulExitMs ?? RUNTIME_CHILD_GRACEFUL_EXIT_MS,
  );
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  if ((await gracefulExit) !== null) return;

  const forcedExit = waitForRuntimeChildTerminalBefore(
    child,
    options.forcedExitMs ?? RUNTIME_CHILD_FORCED_EXIT_MS,
  );
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  if ((await forcedExit) === null) {
    throw new Error("runtime_child_shutdown_timeout");
  }
}

export function desktopRuntimeFingerprint(input: {
  providerId: string;
  endpoint: string;
  modelId: string;
  modelCatalog: readonly string[];
  agentProfiles: readonly Readonly<{
    agentVersionIdSuffix: string;
    instructions: string;
  }>[];
  localWorkspaceMcp: Readonly<{
    configPath: string;
    configDigest: string;
    serverDigest: string;
  }> | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        runtimeContract: "crewon.electron-typescript-runtime.v2",
      }),
    )
    .digest("hex");
}

/** Binds only the workspace selected by the desktop, clearing ambient values. */
export function bindDesktopWorkspaceEnvironment(
  environment: NodeJS.ProcessEnv,
  binding: Readonly<{
    mcpConfig: string | null;
    workspace: string | null;
  }>,
): void {
  if (binding.mcpConfig === null) {
    delete environment.CREWON_MCP_STDIO_CONFIG_PATH;
  } else {
    environment.CREWON_MCP_STDIO_CONFIG_PATH = binding.mcpConfig;
  }
  if (binding.workspace === null) {
    delete environment.CREWON_DESKTOP_WORKSPACE_ROOT;
  } else {
    environment.CREWON_DESKTOP_WORKSPACE_ROOT = binding.workspace;
  }
}

/** Partitions the dedicated Agent Open API key into the worker child only. */
export function agentPlatformRuntimeEnvironments(
  environment: NodeJS.ProcessEnv,
  apiKey: string | null,
): Readonly<{
  sharedEnvironment: NodeJS.ProcessEnv;
  workerEnvironment: NodeJS.ProcessEnv;
}> {
  const sharedEnvironment = { ...environment };
  delete sharedEnvironment.CREWON_AGENT_PLATFORM_API_KEY;
  const workerEnvironment = { ...sharedEnvironment };
  if (apiKey !== null) {
    workerEnvironment.CREWON_AGENT_PLATFORM_API_KEY = apiKey;
  }
  return { sharedEnvironment, workerEnvironment };
}

/** Returns the one credential origin shared by an atomic cloud-profile set. */
export function cloudAgentProfilesOrigin(
  profiles: readonly CloudAgentProfile[],
): string {
  if (profiles.length === 0) {
    throw new Error("cloud_agent_profiles_empty");
  }
  const origins = new Set(
    profiles.map((profile) => cloudAgentProfileOrigin(profile.invocationUrl)),
  );
  if (origins.size !== 1) {
    throw new Error("cloud_agent_profile_origin_mismatch");
  }
  return [...origins][0]!;
}

function cloudAgentProfileOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("cloud_agent_profile_invocation_url_invalid");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("cloud_agent_profile_invocation_url_invalid");
  }
  return url.origin;
}

/**
 * Derives an immutable runtime version ID for a logical cloud Agent profile.
 * The source Agent ID stays readable while runtime/profile changes publish a
 * new version instead of conflicting with an already registered asset.
 */
export function cloudAgentRuntimeVersionId(
  profile: CloudAgentProfile,
  runtimeFingerprint: string,
): string {
  const logicalId = profile.agentVersionId.trim();
  if (
    logicalId.length === 0 ||
    new TextEncoder().encode(logicalId).byteLength > 470 ||
    runtimeFingerprint.trim().length === 0
  ) {
    throw new Error("cloud_agent_profile_identity_invalid");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        agentId: profile.agentId,
        agentVersionId: logicalId,
        authorityContract: "provider-agent-v1",
        instructions: profile.instructions,
        invocationUrl: profile.invocationUrl,
        modelId: profile.modelId,
        runtimeFingerprint,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${logicalId}:${digest}`;
}

export function runtimePaths(options: {
  packaged: boolean;
  repositoryRoot: string;
  resourcesPath: string;
}): RuntimePaths {
  const root = options.packaged
    ? join(options.resourcesPath, "runtime")
    : options.repositoryRoot;
  return options.packaged
    ? {
        control: join(root, "control-api.mjs"),
        modelCatalog: join(root, "provider-model-catalog.mjs"),
        release: join(root, "runtime-release.mjs"),
        worker: join(root, "runtime-worker.mjs"),
        workspaceMcp: join(root, "local-workspace-checks-mcp.mjs"),
        source: false,
      }
    : {
        control: join(root, "apps", "control-api", "src", "main.ts"),
        modelCatalog: join(
          root,
          "apps",
          "runtime-worker",
          "src",
          "provider-model-catalog-main.ts",
        ),
        release: join(root, "apps", "runtime-worker", "src", "release-main.ts"),
        worker: join(root, "apps", "runtime-worker", "src", "main.ts"),
        workspaceMcp: join(root, "scripts", "local-workspace-checks-mcp.mjs"),
        source: true,
      };
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Selects the catalog that owns the desktop runtime identity.
 *
 * Provider discovery is network-backed and can temporarily fail or reorder
 * otherwise equivalent model IDs. Reusing the last known catalog prevents
 * those transient differences from publishing and activating a different
 * local AgentVersion, which would invalidate existing Office memberships.
 */
export function selectDesktopRuntimeModelCatalog(input: {
  cached: readonly string[] | null;
  defaultModelId: string;
  discovered: readonly string[] | null;
}): readonly string[] {
  const fallback = validatedModelCatalog(input.cached, input.defaultModelId);
  const discovered = validatedModelCatalog(
    input.discovered,
    input.defaultModelId,
  );
  if (discovered === null) return fallback ?? [input.defaultModelId];
  if (
    fallback !== null &&
    runnableModelSet(fallback, input.defaultModelId) ===
      runnableModelSet(discovered, input.defaultModelId)
  ) {
    return fallback;
  }
  return discovered;
}

function readModelCatalogCache(
  dataDirectory: string,
  provider: ActiveProvider,
): readonly string[] | null {
  const path = join(dataDirectory, MODEL_CATALOG_CACHE_FILE);
  if (!existsSync(path)) return null;
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 32 * 1024) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== MODEL_CATALOG_CACHE_SCHEMA ||
      value.providerKey !== modelCatalogProviderKey(provider) ||
      !Array.isArray(value.models)
    ) {
      return null;
    }
    return validatedModelCatalog(value.models, provider.modelId);
  } catch {
    return null;
  }
}

function writeModelCatalogCache(
  dataDirectory: string,
  provider: ActiveProvider,
  models: readonly string[],
): void {
  const path = join(dataDirectory, MODEL_CATALOG_CACHE_FILE);
  writeDesktopConfigAtomically(
    path,
    `${JSON.stringify({
      schemaVersion: MODEL_CATALOG_CACHE_SCHEMA,
      providerKey: modelCatalogProviderKey(provider),
      models,
    })}\n`,
  );
}

function modelCatalogProviderKey(provider: ActiveProvider): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        providerId: provider.providerId,
        endpoint: provider.endpoint,
        modelId: provider.modelId,
      }),
    )
    .digest("hex");
}

function validatedModelCatalog(
  value: readonly unknown[] | null,
  defaultModelId: string,
): readonly string[] | null {
  if (value === null) return null;
  if (value.length > MAX_CACHED_MODELS) {
    throw new Error("desktop_model_catalog_invalid");
  }
  const defaultModel = validatedModelId(defaultModelId);
  const seen = new Set([defaultModel]);
  const models = [defaultModel];
  for (const candidate of value) {
    const model = validatedModelId(candidate);
    if (!seen.has(model)) {
      seen.add(model);
      models.push(model);
    }
  }
  return models;
}

function runnableModelSet(
  models: readonly string[],
  defaultModelId: string,
): string {
  const defaultModel = validatedModelId(defaultModelId);
  const runnable = models
    .filter(
      (model) =>
        model !== defaultModel &&
        !NON_AGENT_MODEL_MARKERS.some((marker) =>
          model.toLowerCase().includes(marker),
        ),
    )
    .slice(0, MAX_RUNTIME_MODELS - 1)
    .sort();
  return JSON.stringify([defaultModel, ...runnable]);
}

function validatedModelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value) > MAX_MODEL_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("desktop_model_catalog_invalid");
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nodeArguments(entry: string, source: boolean): string[] {
  return source ? ["--experimental-strip-types", entry] : [entry];
}

function ensureStorage(dataDirectory: string): void {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDirectory, "artifacts"), { recursive: true, mode: 0o700 });
  const key = join(dataDirectory, "artifact-encryption.key");
  if (!existsSync(key)) writeFileSync(key, randomBytes(32), { mode: 0o600 });
  chmodSync(key, 0o600);
  if (!statSync(key).isFile() || statSync(key).size !== 32) {
    throw new Error("artifact_encryption_key_invalid");
  }
}

function responsesEndpoint(base: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/responses`;
  return url.toString();
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForReady(
  url: string,
  children: readonly ChildProcess[],
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (
      children.some(
        (child) => child.exitCode !== null || child.signalCode !== null,
      )
    ) {
      throw new Error("control_runtime_child_exited");
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      });
      await response.body?.cancel();
      if (
        response.ok &&
        children.every(
          (child) => child.exitCode === null && child.signalCode === null,
        )
      )
        return;
    } catch {
      // The listening socket is expected to be absent while migrations finish.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("control_runtime_readiness_timeout");
}

export function watchRuntimeChildren(
  children: readonly Readonly<{ child: ChildProcess; name: string }>[],
  onUnexpectedExit: (event: {
    code: number | null;
    name: string;
    signal: NodeJS.Signals | null;
  }) => void,
): () => void {
  let watching = true;
  const cleanups: (() => void)[] = [];
  const cleanup = () => {
    watching = false;
    for (const remove of cleanups) remove();
  };
  for (const { child, name } of children) {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!watching) return;
      cleanup();
      onUnexpectedExit({ code, name, signal });
    };
    const onError = () => onExit(child.exitCode, child.signalCode);
    child.once("exit", onExit);
    child.once("error", onError);
    cleanups.push(() => {
      child.off("exit", onExit);
      child.off("error", onError);
    });
    if (child.exitCode != null || child.signalCode != null) {
      queueMicrotask(() => onExit(child.exitCode, child.signalCode));
    }
  }
  return cleanup;
}

function executable(name: string): string {
  const pathEntries = (process.env.PATH ?? "").split(
    process.platform === "win32" ? ";" : ":",
  );
  const candidates =
    process.platform === "win32"
      ? [`${name}.cmd`, `${name}.exe`, name]
      : [name];
  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const path = resolve(directory, candidate);
      if (existsSync(path)) return path;
    }
  }
  return name;
}

function pickEnvironment(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]!]],
    ),
  );
}
