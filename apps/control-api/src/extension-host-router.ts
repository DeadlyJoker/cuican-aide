import { createHash } from "node:crypto";
import { inspect } from "node:util";
import type {
  ActorContext,
  ExtensionCatalogPort,
  ExtensionHostPort,
  ExtensionQueryHostPort,
  ExtensionReadiness,
  ExtensionRegistration,
} from "@crewon/application";
import {
  parseExtensionHostActor,
  parseExtensionHostRegistrationIdentity,
} from "@crewon/contracts";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionManifest,
  validateExtensionConfiguration,
} from "@crewon/domain";
import {
  ExtensionHostWorkerError,
  LoopbackExtensionHostClient,
  parseLoopbackExtensionHostConfig,
} from "./extension-worker-client.ts";

export type ExtensionWorkerPeerConfig = Readonly<{
  origin: string;
  token: string;
  deadlineMs?: number;
}>;
export type ExtensionWorkerRouterConfig = ExtensionWorkerPeerConfig &
  Readonly<{ historicalPeers?: readonly ExtensionWorkerPeerConfig[] }>;
export const MAX_HISTORICAL_EXTENSION_PEERS = 4;

/** Trusted standalone peers only; historical metadata never enters the public catalog. */
export class ExtensionHostRouter implements ExtensionHostPort {
  readonly #current: LoopbackExtensionHostClient;
  readonly #peers: readonly LoopbackExtensionHostClient[];
  readonly #deadlineMs: number;
  readonly #queries = new Set<AbortController>();
  readonly #pendingQueries = new Set<Promise<unknown>>();
  #closed = false;
  readonly queryHost: ExtensionQueryHostPort;

  constructor(
    input: ExtensionWorkerRouterConfig,
    dependencies: { fetch?: typeof globalThis.fetch } = {},
  ) {
    const config = parseExtensionWorkerRouterConfig(input);
    this.#current = new LoopbackExtensionHostClient(config, dependencies);
    this.#peers = Object.freeze([
      this.#current,
      ...(config.historicalPeers ?? []).map(
        (peer) => new LoopbackExtensionHostClient(peer, dependencies),
      ),
    ]);
    this.#deadlineMs = Math.max(
      config.deadlineMs ?? 10_000,
      ...(config.historicalPeers ?? []).map(
        (peer) => peer.deadlineMs ?? 10_000,
      ),
    );
    this.queryHost = Object.freeze({
      resolveRegistration: (input) => this.#resolveRegistration(input),
      evaluate: (input) => this.#evaluateQuery(input),
    } satisfies ExtensionQueryHostPort);
  }

  loadCatalog(actor: ActorContext): Promise<ExtensionCatalogPort> {
    return this.#current.loadCatalog(actor);
  }
  validateConfiguration(
    input: Parameters<ExtensionHostPort["validateConfiguration"]>[0],
  ): Promise<void> {
    return this.#current.validateConfiguration(input);
  }
  evaluate(
    input: Parameters<ExtensionHostPort["evaluate"]>[0],
  ): Promise<ExtensionReadiness> {
    return this.#current.evaluate(input);
  }

  async #resolveRegistration(
    input: Parameters<ExtensionQueryHostPort["resolveRegistration"]>[0],
  ): Promise<ExtensionRegistration | null> {
    const actor = parseExtensionHostActor(input.actor);
    const identity = parseExtensionHostRegistrationIdentity(input.identity);
    return this.#query(async (signal) => {
      const catalogs = await this.#catalogs(actor, signal);
      for (const { catalog } of catalogs) {
        const registration = catalog.resolve(identity);
        if (registration !== null && sameIdentity(registration, identity))
          return registration;
      }
      return null;
    });
  }

  async #evaluateQuery(
    input: Parameters<ExtensionQueryHostPort["evaluate"]>[0],
  ): Promise<ExtensionReadiness> {
    // Copy and validate every value before contacting a peer. No caller-owned
    // target, identity or configuration can change across catalog negotiation.
    const actor = parseExtensionHostActor(input.actor);
    const manifest = parseExtensionManifest(input.registration.manifest);
    const identity = parseExtensionHostRegistrationIdentity({
      pluginId: manifest.pluginId,
      pluginVersion: manifest.version,
      manifestDigest: input.registration.manifestDigest,
      implementationDigest: input.registration.implementationDigest,
    });
    if (
      digester.sha256(extensionCanonicalJson(manifest)) !==
      identity.manifestDigest
    )
      throw requestInvalid();
    const registration: ExtensionRegistration = Object.freeze({
      manifest,
      manifestDigest: identity.manifestDigest,
      implementationDigest: identity.implementationDigest,
    });
    const configuration = parseExtensionConfiguration(
      input.configuration,
      digester,
    );
    const expectedTarget = parseExtensionExecutionTarget(input.expectedTarget);
    if (
      expectedTarget.agentVersionId !== input.agentVersionId ||
      configuration.tenantId !== actor.tenantId ||
      configuration.spaceId !== actor.spaceId ||
      !sameIdentity(registration, configuration)
    )
      throw requestInvalid();
    validateExtensionConfiguration(manifest, configuration.parameters);
    const request = Object.freeze({
      actor,
      registration,
      configuration,
      agentVersionId: expectedTarget.agentVersionId,
    });
    return this.#query(async (signal) => {
      const catalogs = await this.#catalogs(actor, signal);
      const candidates = catalogs.filter(({ catalog }) => {
        const found = catalog.resolve(identity);
        return found !== null && sameIdentity(found, identity);
      });
      if (candidates.length === 0)
        return Object.freeze({
          outcome: "unavailable",
          reasonCode: "extension_implementation_unavailable",
        });
      const results = await Promise.allSettled(
        candidates.map(({ client }) => client.evaluate(request, { signal })),
      );
      // Same implementation can have several prepared AgentVersions. A ready
      // response grants no authority unless its entire durable target matches.
      for (const result of results) {
        if (
          result.status === "fulfilled" &&
          result.value.outcome === "ready" &&
          extensionCanonicalJson(result.value.target) ===
            extensionCanonicalJson(expectedTarget)
        )
          return result.value;
      }
      return Object.freeze({
        outcome: "unavailable",
        reasonCode: "extension_runtime_unavailable",
      });
    });
  }

  async #catalogs(actor: ActorContext, signal: AbortSignal) {
    const results = await Promise.allSettled(
      this.#peers.map((client) => client.loadCatalog(actor, { signal })),
    );
    return results.flatMap((result, index) =>
      result.status === "fulfilled"
        ? [{ client: this.#peers[index]!, catalog: result.value }]
        : [],
    );
  }

  #query<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed)
      return Promise.reject(
        new ExtensionHostWorkerError("extension_host_closed"),
      );
    const controller = new AbortController();
    this.#queries.add(controller);
    const timer = setTimeout(
      () =>
        controller.abort(
          new ExtensionHostWorkerError("extension_host_deadline_exceeded"),
        ),
      this.#deadlineMs,
    );
    timer.unref();
    const task = (async () => {
      try {
        const value = await operation(controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        return value;
      } finally {
        clearTimeout(timer);
        this.#queries.delete(controller);
      }
    })();
    this.#pendingQueries.add(task);
    void task.then(
      () => this.#pendingQueries.delete(task),
      () => this.#pendingQueries.delete(task),
    );
    return task;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const reason = new ExtensionHostWorkerError("extension_host_closed");
    for (const controller of this.#queries) controller.abort(reason);
    const closed = await Promise.allSettled(
      this.#peers.map((client) => client.close()),
    );
    await Promise.allSettled([...this.#pendingQueries]);
    const errors = closed.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "extension_host_router_cleanup_failed");
  }
}

/** Pure bounded snapshot, including when the opt-in is disabled. Never dispatches. */
export function parseExtensionWorkerRouterConfig(
  input: unknown,
): ExtensionWorkerRouterConfig {
  const value = dataRecord(input, [
    "origin",
    "token",
    "deadlineMs",
    "historicalPeers",
  ]);
  const current = peerConfig(value);
  const rawPeers = value.historicalPeers;
  const historicalPeers =
    rawPeers === undefined
      ? undefined
      : Object.freeze(
          dataArray(rawPeers).map((peer: unknown) =>
            peerConfig(dataRecord(peer, ["origin", "token", "deadlineMs"])),
          ),
        );
  const origins = [
    current.origin,
    ...(historicalPeers ?? []).map((peer) => peer.origin),
  ];
  if (new Set(origins).size !== origins.length) throw requestInvalid();
  return redacted(
    Object.freeze({
      ...current,
      ...(historicalPeers === undefined ? {} : { historicalPeers }),
    }),
  );
}

function peerConfig(value: Record<string, unknown>): ExtensionWorkerPeerConfig {
  if (
    typeof value.origin !== "string" ||
    typeof value.token !== "string" ||
    (value.deadlineMs !== undefined && typeof value.deadlineMs !== "number")
  )
    throw requestInvalid();
  const checked = parseLoopbackExtensionHostConfig({
    origin: value.origin,
    token: value.token,
    ...(value.deadlineMs === undefined ? {} : { deadlineMs: value.deadlineMs }),
  });
  return redacted(
    Object.freeze({
      origin: checked.origin,
      token: checked.token,
      ...(value.deadlineMs === undefined
        ? {}
        : { deadlineMs: checked.deadlineMs }),
    }),
  );
}
function dataRecord(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw requestInvalid();
  const value: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    // Environment snapshots carry this non-enumerable redaction hook; never call it.
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (
      key === inspect.custom &&
      !descriptor.enumerable &&
      "value" in descriptor &&
      typeof descriptor.value === "function"
    )
      continue;
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      throw requestInvalid();
    value[key] = descriptor.value;
  }
  return value;
}
function dataArray(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || input.length > MAX_HISTORICAL_EXTENSION_PEERS)
    throw requestInvalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length + 1 || !keys.includes("length"))
    throw requestInvalid();
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw requestInvalid();
    result.push(descriptor.value);
  }
  return result;
}
function redacted<T extends object>(input: T): T {
  const value = { ...input };
  Object.defineProperty(value, inspect.custom, {
    value: () => "[ExtensionWorkerPeerConfig]",
    enumerable: false,
  });
  return Object.freeze(value) as T;
}
function sameIdentity(
  registration: ExtensionRegistration,
  identity: Readonly<{
    pluginId: string;
    pluginVersion: string;
    manifestDigest: string;
    implementationDigest: string;
  }>,
): boolean {
  return (
    registration.manifest.pluginId === identity.pluginId &&
    registration.manifest.version === identity.pluginVersion &&
    registration.manifestDigest === identity.manifestDigest &&
    registration.implementationDigest === identity.implementationDigest
  );
}
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`,
};
function requestInvalid(): ExtensionHostWorkerError {
  return new ExtensionHostWorkerError("extension_host_request_invalid");
}
