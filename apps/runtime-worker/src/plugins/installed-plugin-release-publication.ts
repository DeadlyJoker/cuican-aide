import { isDeepStrictEqual } from "node:util";
import {
  createAgentVersionAsset,
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  AgentVersionApplicationService,
  AgentVersionReleaseApplicationService,
  compileAgentVersionReleaseBundle,
  sameAgentVersionReleaseBundle,
  type ActivateAgentVersionReleaseResult,
  type ActorContext,
  type ApplicationClock,
  type AuthorizationPort,
} from "@crewon/application";
import { extensionOpaqueId } from "@crewon/domain";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  verifyRuntimeAgentVersionRelease,
  type RuntimeAgentVersionReleasePlan,
} from "../agent-version-release.ts";
import {
  installedPluginReleaseDigester as digester,
  installedPluginReleaseFailure as fail,
  parseInstalledPluginReleaseDeployment,
} from "./installed-plugin-release-document.ts";
import {
  assertLoadedInstalledPluginRelease,
  verifyInstalledPluginRelease,
  verifyInstalledPluginReleaseInputs,
  type LoadedInstalledPluginRelease,
} from "./installed-plugin-release-loader.ts";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";

type ParentStore = SqliteRunStore | PostgresDomainStore;
export type InstalledPluginReleasePublicationPlan = Readonly<{
  runtime: RuntimeAgentVersionReleasePlan;
  sourceVersions: readonly CompiledAgentVersion[];
}>;
export type InstalledPluginReleasePublicationResult = Readonly<{
  plan: InstalledPluginReleasePublicationPlan;
  activation: ActivateAgentVersionReleaseResult;
  /** A committed activation remains evidence even when current authorization is later withdrawn. */
  verification:
    | Readonly<{ outcome: "verified" }>
    | Readonly<{ outcome: "unavailable"; cause: unknown }>;
}>;
export type InstalledPluginReleasePublication = Readonly<{
  plan: InstalledPluginReleasePublicationPlan;
  publish(
    input: Readonly<{
      actor: ActorContext;
      activationId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<InstalledPluginReleasePublicationResult>;
  close(): Promise<void>;
}>;

/** Borrows the same parent and release; it never creates a provider, Node factory or prerequisite activation. */
export function createInstalledPluginReleasePublication(
  input: Readonly<{
    release: LoadedInstalledPluginRelease;
    runtimePlan: RuntimeAgentVersionReleasePlan;
    store: ParentStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
  }>,
): InstalledPluginReleasePublication {
  assertLoadedInstalledPluginRelease(input.release);
  if (
    !(input.store instanceof SqliteRunStore) &&
    !(input.store instanceof PostgresDomainStore)
  )
    fail("store_invalid");
  const release = input.release;
  const store = input.store;
  const plan = capturePlan(release, input.runtimePlan);
  const authorization = Object.freeze({
    authorize: input.authorization.authorize.bind(input.authorization),
  });
  const clock = Object.freeze({ now: input.clock.now.bind(input.clock) });
  return new Publication({ release, store, plan, authorization, clock });
}

class Publication implements InstalledPluginReleasePublication {
  readonly plan: InstalledPluginReleasePublicationPlan;
  readonly #release: LoadedInstalledPluginRelease;
  readonly #store: ParentStore;
  readonly #versions: AgentVersionApplicationService;
  readonly #releases: AgentVersionReleaseApplicationService;
  readonly #clock: ApplicationClock;
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | null = null;
  constructor(input: {
    release: LoadedInstalledPluginRelease;
    store: ParentStore;
    plan: InstalledPluginReleasePublicationPlan;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
  }) {
    this.plan = input.plan;
    this.#release = input.release;
    this.#store = input.store;
    this.#clock = input.clock;
    this.#versions = new AgentVersionApplicationService(input);
    this.#releases = new AgentVersionReleaseApplicationService({
      ...input,
      digester,
    });
    Object.freeze(this);
  }

  publish(
    input: Parameters<InstalledPluginReleasePublication["publish"]>[0],
  ): Promise<InstalledPluginReleasePublicationResult> {
    const value = ioRecord(input, ["actor", "activationId"], ["signal"]);
    const actor = captureActor(value.actor);
    const activationId = extensionOpaqueId(value.activationId);
    if (actor.tenantId !== this.plan.runtime.bundle.tenantId)
      fail("publication_actor_mismatch");
    const signal =
      value.signal === undefined
        ? this.#controller.signal
        : AbortSignal.any([
            this.#controller.signal,
            value.signal as AbortSignal,
          ]);
    this.#assertLive(signal);
    if (this.#pending.size >= 4) fail("publication_capacity_exhausted");
    // Register physical work before any callback can run or initiate shutdown.
    const task = Promise.resolve().then(() =>
      this.#publish(actor, activationId, signal),
    );
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#controller.abort(
      new Error("installed_plugin_release_publication_closed"),
    );
    this.#closing = Promise.allSettled([...this.#pending]).then(
      () => undefined,
    );
    return this.#closing;
  }

  #assertLive(signal: AbortSignal): void {
    if (this.#closed) fail("publication_closed");
    signal.throwIfAborted();
  }

  async #publish(
    actor: ActorContext,
    activationId: string,
    signal: AbortSignal,
  ): Promise<InstalledPluginReleasePublicationResult> {
    this.#assertLive(signal);
    await verifyInstalledPluginReleaseInputs({
      release: this.#release,
      store: this.#store,
      signal,
    });
    const versions = new Map(
      [...this.plan.sourceVersions, ...this.plan.runtime.versions].map(
        (version) => [version.agentVersionId, version],
      ),
    );
    for (const version of versions.values()) {
      this.#assertLive(signal);
      await this.#versions.publish(
        actor,
        createAgentVersionAsset({
          tenantId: actor.tenantId,
          version,
          createdAt: this.#clock.now(),
        }),
      );
    }
    this.#assertLive(signal);
    await verifyInstalledPluginReleaseInputs({
      release: this.#release,
      store: this.#store,
      signal,
    });
    this.#assertLive(signal);
    // From this point the original service owns the real transaction; cancellation cannot erase its receipt.
    const activation = await this.#releases.activate(
      actor,
      this.plan.runtime.bundle,
      activationId,
    );
    try {
      this.#assertLive(signal);
      await verifyInstalledPluginRelease({
        release: this.#release,
        store: this.#store,
        signal,
      });
      await verifyRuntimeAgentVersionRelease({
        tenantId: actor.tenantId,
        store: this.#store,
        plan: this.plan.runtime,
        digester,
      });
      this.#assertLive(signal);
      return Object.freeze({
        plan: this.plan,
        activation,
        verification: Object.freeze({ outcome: "verified" as const }),
      });
    } catch (cause) {
      return Object.freeze({
        plan: this.plan,
        activation,
        verification: Object.freeze({ outcome: "unavailable" as const, cause }),
      });
    }
  }
}

function capturePlan(
  release: LoadedInstalledPluginRelease,
  input: RuntimeAgentVersionReleasePlan,
): InstalledPluginReleasePublicationPlan {
  const value = ioRecord(input, [
    "bootstrapVersion",
    "versions",
    "deployments",
    "bundle",
  ]);
  let bytes =
    1024 +
    Buffer.byteLength(
      JSON.stringify(
        release.document.entries.map((entry) => entry.modelSource.version),
      ),
    );
  const snapshot = (input: unknown, maximum: number) => {
    const copied = ioJson(input, maximum);
    bytes += Buffer.byteLength(JSON.stringify(copied)) + 2;
    if (bytes > 32 * 1024 * 1024) fail("publication_plan_limit");
    return copied;
  };
  // Charge every own-data record before semantic parsing: many individually bounded versions cannot exceed the aggregate budget.
  const capturedBootstrap = snapshot(value.bootstrapVersion, 1024 * 1024);
  const capturedVersions = dense(value.versions).map((entry) =>
    snapshot(entry, 1024 * 1024),
  );
  const capturedDeployments = dense(value.deployments).map((entry) =>
    snapshot(entry, 16_384),
  );
  const supplied = snapshot(value.bundle, 1024 * 1024);
  const version = (input: unknown) =>
    parseCompiledAgentVersion(JSON.stringify(input), digester);
  const bootstrapVersion = version(capturedBootstrap);
  const versions = capturedVersions.map(version);
  const deployments = capturedDeployments.map(
    parseInstalledPluginReleaseDeployment,
  );
  const bundle = compileAgentVersionReleaseBundle(
    {
      tenantId: release.document.tenantId,
      defaultAgentVersionId: release.document.defaultAgentVersionId,
      deployments,
    },
    digester,
  );
  if (
    !sameAgentVersionReleaseBundle(bundle, supplied as typeof bundle) ||
    bootstrapVersion.agentVersionId !== bundle.defaultAgentVersionId ||
    deployments.some((entry) => entry.tenantId !== bundle.tenantId) ||
    new Set(deployments.map((entry) => entry.agentVersionId)).size !==
      deployments.length ||
    new Set(versions.map((entry) => entry.agentVersionId)).size !==
      versions.length ||
    !isDeepStrictEqual(
      versions.find(
        (entry) => entry.agentVersionId === bootstrapVersion.agentVersionId,
      ),
      bootstrapVersion,
    )
  )
    fail("publication_plan_mismatch");
  const byId = new Map(
    deployments.map((entry) => [entry.agentVersionId, entry]),
  );
  for (const candidate of [
    ...release.deployments,
    ...release.document.entries.map((entry) => entry.modelSource.deployment),
  ]) {
    const actual = byId.get(candidate.agentVersionId);
    if (actual === undefined) fail("publication_source_deployment_missing");
    if (!isDeepStrictEqual(actual, candidate))
      fail("publication_deployment_mismatch");
  }
  const versionById = new Map(
    versions.map((entry) => [entry.agentVersionId, entry]),
  );
  for (const actual of versions) {
    if (byId.get(actual.agentVersionId)?.contentDigest !== actual.contentDigest)
      fail("publication_version_mismatch");
  }
  for (const expected of release.versions) {
    if (!isDeepStrictEqual(versionById.get(expected.agentVersionId), expected))
      fail("publication_version_mismatch");
  }
  const sources = new Map<string, CompiledAgentVersion>();
  for (const entry of release.document.entries) {
    const source = entry.modelSource.version;
    for (const previous of [
      sources.get(source.agentVersionId),
      versionById.get(source.agentVersionId),
    ]) {
      if (previous !== undefined && !isDeepStrictEqual(previous, source))
        fail("publication_source_version_conflict");
    }
    sources.set(source.agentVersionId, source);
  }
  const runtime = { bootstrapVersion, versions, deployments, bundle };
  if (
    Buffer.byteLength(
      JSON.stringify({ runtime, sourceVersions: [...sources.values()] }),
    ) >
    32 * 1024 * 1024
  )
    fail("publication_plan_limit");
  return freeze({ runtime, sourceVersions: [...sources.values()] });
}

function dense(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 1000)
    fail("publication_plan_invalid");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== input.length + 1)
    fail("publication_plan_invalid");
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = fields[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor))
      fail("publication_plan_invalid");
    return descriptor.value as unknown;
  });
}

function captureActor(input: unknown): ActorContext {
  const value = ioRecord(input, [
    "tenantId",
    "spaceId",
    "actorId",
    "principalId",
  ]);
  return Object.freeze({
    tenantId: extensionOpaqueId(value.tenantId),
    spaceId: extensionOpaqueId(value.spaceId),
    actorId: extensionOpaqueId(value.actorId),
    principalId: extensionOpaqueId(value.principalId),
  });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
