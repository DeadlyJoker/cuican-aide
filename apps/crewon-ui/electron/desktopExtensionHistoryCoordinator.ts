import type { ChildProcess } from "node:child_process";
import { listExtensionRecoveryCapsules } from "@crewon/agent-version/extension-recovery";
import type {
  ProviderRuntimeCredentialInput,
  ProviderRuntimeCredentialResolution,
} from "./providerCredentials.ts";
import {
  DesktopExtensionHistoricalHosts,
  type DesktopExtensionHistoricalHostPeer,
} from "./desktopExtensionHistoricalHosts.ts";
import {
  prepareDesktopExtensionHistoricalWorker,
  type DesktopExtensionHistoricalWorkerLaunchPlan,
} from "./desktopExtensionHistoricalInputs.ts";
import {
  desktopControlHistoricalEnvironment,
  replaceDesktopControlRuntime,
  type DesktopCurrentRuntimeChildren,
} from "./desktopControlRuntime.ts";

type Dependencies = Readonly<{
  dataRoot: string;
  currentCapsuleId: string | null;
  controlEnvironment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  deadlineMs?: number;
  resolveProvider: (
    input: ProviderRuntimeCredentialInput,
  ) => ProviderRuntimeCredentialResolution;
  spawnHistoricalWorker: (
    entry: string,
    environment: NodeJS.ProcessEnv,
  ) => ChildProcess;
  spawnControl: (environment: NodeJS.ProcessEnv) => ChildProcess;
  terminate: (child: ChildProcess) => Promise<void>;
  trackChild: (child: ChildProcess) => void;
  releaseChild: (child: ChildProcess) => void;
  isCurrent: () => boolean;
  currentChildren: () => DesktopCurrentRuntimeChildren | null;
  beginControlReplacement: () => void | Promise<void>;
  registerControlReplacement: (children: DesktopCurrentRuntimeChildren) => void;
  restoreUnchangedControl: () => void;
  finishControlReplacement: (children: DesktopCurrentRuntimeChildren) => void;
  waitForControlReady: (
    children: readonly ChildProcess[],
    signal: AbortSignal,
  ) => Promise<void>;
  diagnostic: (reasonCode: string) => void;
}>;

/** Current health stays in Supervisor; this module owns historical startup and peer updates. */
export class DesktopExtensionHistoryCoordinator {
  readonly #dependencies: Dependencies;
  readonly #manager: DesktopExtensionHistoricalHosts;
  #startup: Promise<void> | null = null;
  #peerUpdates: Promise<void> = Promise.resolve();
  #peerIdentity = "[]";
  #failedPeerIdentity: string | null = null;

  constructor(dependencies: Dependencies) {
    this.#dependencies = Object.freeze({
      ...dependencies,
      controlEnvironment: { ...dependencies.controlEnvironment },
    });
    this.#manager = new DesktopExtensionHistoricalHosts({
      dataRoot: dependencies.dataRoot,
      deadlineMs: dependencies.deadlineMs,
      launchPlans: (signal) => this.#launchPlans(signal),
      spawnWorker: dependencies.spawnHistoricalWorker,
      terminate: dependencies.terminate,
      trackChild: dependencies.trackChild,
      releaseChild: dependencies.releaseChild,
      onDiagnostic: dependencies.diagnostic,
      onPeersChanged: (peers) => this.#updatePeers(peers),
    });
  }

  start(): void {
    if (this.#startup !== null) return;
    const pending = this.#manager
      .start({ signal: this.#dependencies.signal })
      .catch(() => {
        if (!this.#dependencies.signal.aborted)
          this.#dependencies.diagnostic(
            "desktop_extension_historical_start_unavailable",
          );
      });
    this.#startup = pending;
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled([
      this.#manager.stop(),
      this.#startup,
      this.#peerUpdates,
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (this.#manager.ownedChildren.length > 0 && failures.length > 0)
      throw new AggregateError(failures, "runtime_historical_shutdown_failed");
  }

  async #launchPlans(
    signal: AbortSignal,
  ): Promise<readonly DesktopExtensionHistoricalWorkerLaunchPlan[]> {
    const dependencies = this.#dependencies;
    const inventory = await listExtensionRecoveryCapsules({
      dataRoot: dependencies.dataRoot,
    });
    const plans: DesktopExtensionHistoricalWorkerLaunchPlan[] = [];
    for (const capsule of inventory.capsules) {
      signal.throwIfAborted();
      if (capsule.manifest.capsuleId === dependencies.currentCapsuleId)
        continue;
      if (plans.length === 4) {
        dependencies.diagnostic(
          "desktop_extension_historical_capacity_exceeded",
        );
        break;
      }
      const prepared = await prepareDesktopExtensionHistoricalWorker({
        selection: {
          dataRoot: dependencies.dataRoot,
          capsuleId: capsule.manifest.capsuleId,
        },
        resolveProvider: dependencies.resolveProvider,
        signal,
      });
      if (prepared.outcome === "ready") plans.push(prepared);
      else dependencies.diagnostic(prepared.reasonCode);
    }
    if (inventory.unavailable.length > 0)
      dependencies.diagnostic(
        "desktop_extension_historical_capsule_unavailable",
      );
    return plans;
  }

  #updatePeers(
    peers: readonly DesktopExtensionHistoricalHostPeer[],
  ): Promise<void> {
    const dependencies = this.#dependencies;
    const environment = desktopControlHistoricalEnvironment({
      environment: dependencies.controlEnvironment,
      peers,
    });
    const identity = environment.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON ?? "[]";
    const update = this.#peerUpdates
      .catch(() => undefined)
      .then(async () => {
        const signal = dependencies.signal;
        if (signal.aborted || !dependencies.isCurrent()) return;
        if (identity === this.#failedPeerIdentity) return;
        this.#failedPeerIdentity = null;
        if (identity === this.#peerIdentity) return;
        const current = dependencies.currentChildren();
        if (current === null) return;
        await dependencies.beginControlReplacement();
        let registered: DesktopCurrentRuntimeChildren | null = null;
        try {
          const replacement = await replaceDesktopControlRuntime({
            current,
            environment,
            signal,
            terminateControl: dependencies.terminate,
            spawnControl: (environment) => {
              signal.throwIfAborted();
              if (!dependencies.isCurrent())
                throw new Error(
                  "desktop_extension_historical_control_update_stale",
                );
              return dependencies.spawnControl(environment);
            },
            trackChild: dependencies.trackChild,
            onControlSpawned: (children) => {
              registered = children;
              dependencies.registerControlReplacement(children);
              dependencies.releaseChild(current.control);
            },
            waitForReady: dependencies.waitForControlReady,
          });
          signal.throwIfAborted();
          if (!dependencies.isCurrent()) return;
          dependencies.finishControlReplacement(replacement);
          this.#peerIdentity = identity;
        } catch (error) {
          if (signal.aborted || !dependencies.isCurrent()) throw error;
          if (registered === null) dependencies.restoreUnchangedControl();
          else await this.#restoreBaselineControl(registered);
          if (signal.aborted || !dependencies.isCurrent()) throw error;
          this.#failedPeerIdentity = identity;
          dependencies.diagnostic(
            "desktop_extension_historical_control_update_failed",
          );
          throw error;
        }
      });
    this.#peerUpdates = update;
    return update;
  }

  /** A peer update may fail after killing a healthy Control. Recover the original route once. */
  async #restoreBaselineControl(
    failed: DesktopCurrentRuntimeChildren,
  ): Promise<void> {
    const dependencies = this.#dependencies;
    const signal = dependencies.signal;
    signal.throwIfAborted();
    if (!dependencies.isCurrent()) return;
    const environment = desktopControlHistoricalEnvironment({
      environment: dependencies.controlEnvironment,
      peers: [],
    });
    let registered = failed;
    await dependencies.beginControlReplacement();
    try {
      const replacement = await replaceDesktopControlRuntime({
        current: failed,
        environment,
        signal,
        terminateControl: dependencies.terminate,
        spawnControl: (environment) => {
          signal.throwIfAborted();
          if (!dependencies.isCurrent())
            throw new Error(
              "desktop_extension_historical_control_update_stale",
            );
          return dependencies.spawnControl(environment);
        },
        trackChild: dependencies.trackChild,
        onControlSpawned: (children) => {
          registered = children;
          dependencies.registerControlReplacement(children);
          dependencies.releaseChild(failed.control);
        },
        waitForReady: dependencies.waitForControlReady,
      });
      signal.throwIfAborted();
      if (!dependencies.isCurrent()) return;
      dependencies.finishControlReplacement(replacement);
      this.#peerIdentity = "[]";
    } catch {
      if (!signal.aborted && dependencies.isCurrent()) {
        // Keep supervision and ownership of an unready or failed-to-stop child.
        dependencies.registerControlReplacement(registered);
        dependencies.diagnostic(
          "desktop_extension_historical_control_recovery_failed",
        );
      }
    }
  }
}
