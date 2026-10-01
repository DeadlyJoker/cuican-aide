import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { inspect } from "node:util";
import { RUNTIME_BOOTSTRAP_INPUTS_MAX_BYTES } from "@crewon/contracts";
import { parseExtensionRecoveryManifest } from "@crewon/agent-version/extension-recovery";
import { extensionCanonicalJson } from "@crewon/domain";
import type { DesktopExtensionHistoricalWorkerLaunchPlan } from "./desktopExtensionHistoricalInputs.ts";
import { verifyDesktopExtensionRecoveryHost } from "./desktopExtensionRecovery.ts";
import {
  challengeDesktopExtensionHost,
  DESKTOP_RUNTIME_OWNER,
  waitForDesktopExtensionHost,
} from "./desktopExtensionRuntime.ts";

const HISTORICAL_ENVIRONMENT_NAMES = new Set([
  "ELECTRON_RUN_AS_NODE",
  "NODE_ENV",
  "CREWON_CONTROL_SECURITY_MODE",
  "CREWON_MODEL_ADAPTER",
  "CREWON_MODEL_ID",
  "CREWON_MODEL_CREDENTIAL_REQUIRED",
  "CREWON_MODEL_API_KEY",
  "CREWON_RESPONSES_ENDPOINT",
  "CREWON_RESPONSES_MAX_OUTPUT_TOKENS",
  "CREWON_RESPONSES_STORE",
  "CREWON_RESPONSES_REQUEST_PROFILE",
  "CREWON_RESPONSES_IDLE_TIMEOUT_MS",
  "CREWON_RESPONSES_SEQUENCE_POLICY",
  "CREWON_RESPONSES_WEBSOCKET_ENABLED",
  "CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS",
  "CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES",
  "CREWON_AGENT_INSTRUCTIONS",
  "CREWON_MODEL_CONTEXT_WINDOW_TOKENS",
  "CREWON_AUTO_COMPACT_AT_TOKENS",
  "CREWON_RESPONSES_STREAM_MAX_RETRIES",
  "CREWON_AUTHORITY_ID",
  "CREWON_RUNTIME_GENERATION",
  "CREWON_AGENT_VERSION_ID",
  "CREWON_POLICY_SNAPSHOT_ID",
  "CREWON_MODEL_CATALOG_JSON",
  "CREWON_DEV_AGENT_PROFILES_JSON",
  "CREWON_NATIVE_WORKSPACE_READ_ENABLED",
  "CREWON_PRINCIPAL_ID",
  "CREWON_ACTOR_ID",
  "CREWON_TENANT_ID",
  "CREWON_SPACE_ID",
  "CREWON_CONTROL_DB_PATH",
  "CREWON_ARTIFACT_DB_PATH",
  "CREWON_ARTIFACT_ROOT",
  "CREWON_ARTIFACT_ENCRYPTION_KEY_PATH",
  "CREWON_ARTIFACT_ENCRYPTION_KEY_ID",
  "CREWON_AGENT_VERSION_CONTENT_DIGEST",
  "CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH",
  "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
  "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
  "CREWON_EXTENSIONS_ENABLED",
  "CREWON_EXTENSION_EXECUTION_MODE",
  "CREWON_EXTENSION_HOST_PORT",
  "CREWON_EXTENSION_HOST_TOKEN",
  "CREWON_EXTENSION_HOST_DEADLINE_MS",
]);

export type DesktopExtensionHistoricalHostPeer = Readonly<{
  origin: string;
  token: string;
  deadlineMs: number;
}>;
export type DesktopExtensionHistoricalHostDiagnostic =
  | "desktop_extension_historical_plans_unavailable"
  | "desktop_extension_historical_host_unavailable"
  | "desktop_extension_historical_peer_update_failed"
  | "desktop_extension_historical_shutdown_failed";
export type DesktopExtensionHistoricalHostsDependencies = Readonly<{
  dataRoot: string;
  launchPlans: (
    signal: AbortSignal,
  ) => Promise<readonly DesktopExtensionHistoricalWorkerLaunchPlan[]>;
  spawnWorker: (entry: string, environment: NodeJS.ProcessEnv) => ChildProcess;
  terminate: (child: ChildProcess) => Promise<void>;
  trackChild: (child: ChildProcess) => void;
  releaseChild: (child: ChildProcess) => void;
  onPeersChanged: (
    peers: readonly DesktopExtensionHistoricalHostPeer[],
  ) => Promise<void>;
  onDiagnostic?: (code: DesktopExtensionHistoricalHostDiagnostic) => void;
  deadlineMs?: number;
}>;

type OwnedHost = {
  key: string;
  plan: DesktopExtensionHistoricalWorkerLaunchPlan;
  abort: AbortController;
  child: ChildProcess | null;
  closed: boolean;
  processFailed: boolean;
  tracked: boolean;
  released: boolean;
  diagnosed: boolean;
  peer: DesktopExtensionHistoricalHostPeer | null;
  settling: Promise<void> | null;
  close: Promise<void>;
  markClosed: () => void;
};

/** Owns only retained Workers; a failed historical peer never restarts the current pair. */
export class DesktopExtensionHistoricalHosts {
  readonly #dependencies: DesktopExtensionHistoricalHostsDependencies;
  readonly #hosts = new Map<string, OwnedHost>();
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #lifetime: AbortController | null = null;
  #removeExternalAbort: (() => void) | null = null;
  #generation = 0;
  #shutdownRequested = false;
  #updates: Promise<void> = Promise.resolve();
  #pendingUpdates = 0;

  constructor(dependencies: DesktopExtensionHistoricalHostsDependencies) {
    assertPath(dependencies.dataRoot);
    this.#dependencies = Object.freeze({
      ...dependencies,
      deadlineMs: deadline(dependencies.deadlineMs),
    });
  }

  get peers(): readonly DesktopExtensionHistoricalHostPeer[] {
    return Object.freeze(
      [...this.#hosts.values()].flatMap((host) =>
        host.peer !== null && !host.abort.signal.aborted && !terminal(host)
          ? [host.peer]
          : [],
      ),
    );
  }

  get ownedChildren(): readonly ChildProcess[] {
    return Object.freeze(
      [...this.#hosts.values()].flatMap((host) =>
        host.child !== null ? [host.child] : [],
      ),
    );
  }

  start(input: Readonly<{ signal: AbortSignal }>): Promise<void> {
    if (this.#starting !== null) return this.#starting;
    if (
      this.#stopping !== null ||
      (this.#shutdownRequested && this.#pendingUpdates > 0)
    )
      return Promise.reject(new Error("desktop_extension_historical_stopping"));
    if (this.#hosts.size > 0) return Promise.resolve();
    const signal = input.signal;
    if (signal.aborted)
      return Promise.reject(
        new Error("desktop_extension_historical_start_aborted"),
      );
    const lifetime = new AbortController();
    this.#removeExternalAbort?.();
    this.#lifetime?.abort();
    ++this.#generation;
    this.#shutdownRequested = false;
    this.#lifetime = lifetime;
    const abort = () => {
      lifetime.abort();
      void this.stop().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    this.#removeExternalAbort = () =>
      signal.removeEventListener("abort", abort);
    const starting = this.#startPlans(lifetime);
    this.#starting = starting;
    void starting
      .finally(() => {
        if (this.#starting === starting) this.#starting = null;
        if (this.#hosts.size === 0 && this.#lifetime === lifetime) {
          this.#removeExternalAbort?.();
          this.#removeExternalAbort = null;
          this.#lifetime = null;
        }
      })
      .catch(() => undefined);
    return starting;
  }

  stop(): Promise<void> {
    if (this.#stopping !== null) return this.#stopping;
    this.#shutdownRequested = true;
    ++this.#generation;
    this.#removeExternalAbort?.();
    this.#removeExternalAbort = null;
    this.#lifetime?.abort();
    this.#lifetime = null;
    for (const host of this.#hosts.values()) {
      host.peer = null;
      host.abort.abort();
    }
    const stopping = this.#stopHosts();
    this.#stopping = stopping;
    void stopping
      .finally(() => {
        if (this.#stopping === stopping) this.#stopping = null;
      })
      .catch(() => undefined);
    return stopping;
  }

  async #startPlans(lifetime: AbortController): Promise<void> {
    let plans: readonly DesktopExtensionHistoricalWorkerLaunchPlan[];
    const preparationSignal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(this.#dependencies.deadlineMs!),
    ]);
    try {
      plans = snapshotPlans(
        await untilAbort(
          this.#dependencies.launchPlans(preparationSignal),
          preparationSignal,
        ),
      );
      preparationSignal.throwIfAborted();
    } catch {
      if (lifetime.signal.aborted) return;
      this.#diagnostic("desktop_extension_historical_plans_unavailable");
      return;
    }
    const hosts = plans.map((plan) => {
      let markClosed!: () => void;
      const close = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      const host: OwnedHost = {
        key: plan.manifest.capsuleId,
        plan,
        abort: new AbortController(),
        child: null,
        closed: false,
        processFailed: false,
        tracked: false,
        released: false,
        diagnosed: false,
        peer: null,
        settling: null,
        close,
        markClosed,
      };
      this.#hosts.set(host.key, host);
      return host;
    });
    await Promise.allSettled(
      hosts.map((host) => this.#startHost(host, lifetime.signal)),
    );
  }

  async #startHost(host: OwnedHost, lifetime: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([
      lifetime,
      host.abort.signal,
      AbortSignal.timeout(host.plan.deadlineMs),
    ]);
    try {
      signal.throwIfAborted();
      const child = this.#dependencies.spawnWorker(host.plan.workerPath, {
        ...host.plan.environment,
      });
      host.child = child;
      // Both owners retain the handle before readiness, HTTP or callback awaits.
      this.#watch(host, child);
      this.#dependencies.trackChild(child);
      host.tracked = true;
      const origin = await waitForDesktopExtensionHost(child, {
        signal,
        deadlineMs: host.plan.deadlineMs,
      });
      const catalog = await challengeDesktopExtensionHost({
        origin,
        token: host.plan.token,
        signal,
        deadlineMs: host.plan.deadlineMs,
        expectedRegistrations: host.plan.manifest.registrations,
      });
      await verifyDesktopExtensionRecoveryHost({
        dataRoot: this.#dependencies.dataRoot,
        manifest: host.plan.manifest,
        origin,
        token: host.plan.token,
        signal,
        deadlineMs: host.plan.deadlineMs,
        catalog,
      });
      signal.throwIfAborted();
      if (terminal(host) || host.processFailed || child.pid === undefined)
        throw new Error("desktop_extension_historical_host_unavailable");
      host.peer = Object.freeze({
        origin,
        token: host.plan.token,
        deadlineMs: host.plan.deadlineMs,
      });
      // Control restarts have their own budget; readiness has already completed.
      await untilAbort(this.#publish(), lifetime);
    } catch {
      host.peer = null;
      host.abort.abort();
      if (!lifetime.aborted) this.#hostUnavailable(host);
      await this.#settle(host).catch(() => {
        this.#diagnostic("desktop_extension_historical_shutdown_failed");
      });
    }
  }

  #watch(host: OwnedHost, child: ChildProcess): void {
    const failed = () => {
      host.peer = null;
      host.abort.abort();
      if (!this.#shutdownRequested) {
        this.#hostUnavailable(host);
        void this.#publish();
      }
    };
    const onError = () => {
      host.processFailed = true;
      failed();
      if (child.pid !== undefined)
        void this.#settle(host).catch(() => {
          this.#diagnostic("desktop_extension_historical_shutdown_failed");
        });
    };
    const onExit = () => {
      failed();
      queueMicrotask(() => this.#release(host));
    };
    const onClose = () => {
      host.closed = true;
      host.markClosed();
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      queueMicrotask(() => this.#release(host));
    };
    child.on("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null)
      queueMicrotask(onExit);
  }

  async #stopHosts(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#hosts.values()].map((host) => this.#settle(host)),
    );
    await this.#starting?.catch(() => undefined);
    try {
      await untilAbort(
        this.#updates,
        AbortSignal.timeout(this.#dependencies.deadlineMs!),
      );
    } catch {
      this.#diagnostic("desktop_extension_historical_shutdown_failed");
      throw new Error("desktop_extension_historical_shutdown_failed");
    }
    if (
      results.some((result) => result.status === "rejected") ||
      this.#hosts.size > 0
    ) {
      this.#diagnostic("desktop_extension_historical_shutdown_failed");
      throw new Error("desktop_extension_historical_shutdown_failed");
    }
  }

  #settle(host: OwnedHost): Promise<void> {
    if (host.settling !== null) return host.settling;
    const settling = (async () => {
      if (host.child === null || terminal(host)) {
        this.#release(host);
        return;
      }
      if (host.processFailed && host.child.pid === undefined)
        await untilAbort(host.close, AbortSignal.timeout(host.plan.deadlineMs));
      else await this.#dependencies.terminate(host.child);
      if (!terminal(host))
        throw new Error("desktop_extension_historical_shutdown_failed");
      this.#release(host);
    })();
    host.settling = settling;
    void settling
      .finally(() => {
        if (host.settling === settling) host.settling = null;
      })
      .catch(() => undefined);
    return settling;
  }

  #release(host: OwnedHost): void {
    if (host.released || (host.child !== null && !terminal(host))) return;
    host.released = true;
    if (this.#hosts.get(host.key) === host) this.#hosts.delete(host.key);
    if (host.child !== null && host.tracked) {
      try {
        this.#dependencies.releaseChild(host.child);
      } catch {
        this.#diagnostic("desktop_extension_historical_shutdown_failed");
      }
    }
  }

  #publish(): Promise<void> {
    ++this.#pendingUpdates;
    const generation = this.#generation;
    const update = this.#updates.then(async () => {
      if (generation !== this.#generation || this.#shutdownRequested) return;
      try {
        await this.#dependencies.onPeersChanged(this.peers);
      } catch {
        this.#diagnostic("desktop_extension_historical_peer_update_failed");
      }
    });
    this.#updates = update;
    void update
      .finally(() => {
        --this.#pendingUpdates;
      })
      .catch(() => undefined);
    return update;
  }

  #hostUnavailable(host: OwnedHost): void {
    if (host.diagnosed) return;
    host.diagnosed = true;
    this.#diagnostic("desktop_extension_historical_host_unavailable");
  }

  #diagnostic(code: DesktopExtensionHistoricalHostDiagnostic): void {
    try {
      this.#dependencies.onDiagnostic?.(code);
    } catch {
      /* Diagnostics cannot change process ownership or current startup. */
    }
  }
}

function terminal(host: OwnedHost): boolean {
  const child = host.child;
  return (
    child !== null &&
    (child.pid === undefined
      ? host.closed && host.processFailed
      : child.exitCode !== null || child.signalCode !== null)
  );
}

function snapshotPlans(
  input: readonly DesktopExtensionHistoricalWorkerLaunchPlan[],
): readonly DesktopExtensionHistoricalWorkerLaunchPlan[] {
  if (
    !Array.isArray(input) ||
    input.length > 4 ||
    Object.keys(input).length !== input.length ||
    Object.getOwnPropertySymbols(input).length > 0
  )
    invalid();
  const plans = Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor)) invalid();
    const value = dataRecord(descriptor.value, true);
    const keys = [
      "outcome",
      "manifest",
      "workerPath",
      "environment",
      "token",
      "deadlineMs",
    ];
    if (
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      value.outcome !== "ready"
    )
      invalid();
    const manifest = parseExtensionRecoveryManifest(value.manifest);
    if (
      extensionCanonicalJson(manifest.owner) !==
      extensionCanonicalJson(DESKTOP_RUNTIME_OWNER)
    )
      invalid();
    assertPath(value.workerPath);
    const environment = dataRecord(
      value.environment,
      true,
    ) as NodeJS.ProcessEnv;
    if (
      Object.keys(environment).length > 64 ||
      Object.entries(environment).some(
        ([key, entry]) =>
          !HISTORICAL_ENVIRONMENT_NAMES.has(key) ||
          typeof entry !== "string" ||
          Buffer.byteLength(entry) > RUNTIME_BOOTSTRAP_INPUTS_MAX_BYTES,
      ) ||
      Buffer.byteLength(JSON.stringify(environment)) >
        2 * RUNTIME_BOOTSTRAP_INPUTS_MAX_BYTES
    )
      invalid();
    if (
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.token) ||
      environment.CREWON_EXTENSION_HOST_TOKEN !== value.token ||
      environment.CREWON_EXTENSION_HOST_PORT !== "0" ||
      environment.CREWON_EXTENSION_EXECUTION_MODE !== "historical" ||
      environment.CREWON_EXTENSIONS_ENABLED !== "1" ||
      environment.CREWON_CONTROL_SECURITY_MODE !== "standalone" ||
      typeof value.deadlineMs !== "number" ||
      Object.entries(DESKTOP_RUNTIME_OWNER).some(
        ([key, expected]) =>
          environment[`CREWON_${key.replace(/Id$/u, "_ID").toUpperCase()}`] !==
          expected,
      )
    )
      invalid();
    // Even a reused trusted plan receives a new private capability on every start.
    const token = randomBytes(32).toString("hex");
    environment.CREWON_EXTENSION_HOST_TOKEN = token;
    return Object.freeze({
      outcome: "ready" as const,
      manifest,
      workerPath: value.workerPath as string,
      environment: Object.freeze(environment),
      token,
      deadlineMs: deadline(value.deadlineMs as number),
    });
  });
  if (
    new Set(plans.map((plan) => plan.manifest.capsuleId)).size !== plans.length
  )
    invalid();
  return Object.freeze(plans);
}

function dataRecord(value: unknown, redacted = false): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).some((symbol) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, symbol)!;
      return (
        !redacted ||
        symbol !== inspect.custom ||
        descriptor.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "function"
      );
    })
  )
    invalid();
  const entries = Object.entries(
    Object.getOwnPropertyDescriptors(value),
  ).filter(
    ([key, descriptor]) =>
      !(
        redacted &&
        key === "toJSON" &&
        !descriptor.enumerable &&
        "value" in descriptor &&
        typeof descriptor.value === "function"
      ),
  );
  if (
    entries.some(
      ([, descriptor]) => !("value" in descriptor) || !descriptor.enumerable,
    )
  )
    invalid();
  return Object.fromEntries(
    entries.map(([key, descriptor]) => [key, descriptor.value]),
  );
}
function assertPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !isAbsolute(value) ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    Buffer.byteLength(value) > 4096
  )
    invalid();
}
function deadline(value: number | undefined): number {
  const result = value ?? 20_000;
  if (!Number.isSafeInteger(result) || result < 1000 || result > 30_000)
    invalid();
  return result;
}
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () =>
      reject(new Error("desktop_extension_historical_start_aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted))
      .catch(() => undefined);
    if (signal.aborted) aborted();
  });
}
function invalid(): never {
  throw new Error("desktop_extension_historical_plans_invalid");
}
