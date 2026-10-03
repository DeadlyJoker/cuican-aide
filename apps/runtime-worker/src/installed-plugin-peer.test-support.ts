import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ExtensionConfigurationApplicationService,
  ExtensionTaskApplicationService,
  ThreadApplicationService,
  type AuthorizationPort,
  type ExtensionHostPort,
} from "@crewon/application";
import {
  INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  parseInstalledPluginPeerResponse,
} from "@crewon/contracts/plugins";
import {
  parsePluginTaskAdmissionPin,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { UuidV7ApplicationIdGenerator } from "./standalone-adapters.ts";
import { InstalledPluginExecutionReadinessOwner } from "./plugins/installed-plugin-execution-readiness.ts";
import { composeInstalledPluginPeer } from "./plugins/installed-plugin-peer-composition.ts";
import type { InstalledPluginExecutionIoConfig } from "./plugins/installed-plugin-execution-io-config.ts";
import {
  digester,
  installedReleaseFixture,
  releaseActor as actor,
  timestamp,
} from "./installed-plugin-release-loader.test-support.ts";

export { actor, digester };
export const token = "actual-installed-private-peer-token-at-least-32-bytes";
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function post(
  origin: string,
  body: unknown,
  options: RequestInit = {},
) {
  return fetch(origin + INSTALLED_PLUGIN_PEER_PRIVATE_PATH, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...options,
  });
}

/** Real immutable installed SDK bytes, publication and same parent Store. No model/provider request is made. */
export async function peerFixture(
  t: TestContext,
  backend: "sqlite" | "postgres" = "sqlite",
  versions: 1 | 2 = 1,
  options: Readonly<{ activate?: boolean }> = {},
) {
  const f = await installedReleaseFixture(t, backend, { versions });
  const extensions = f.store.extensionStore();
  await extensions.migratePluginAdmissions();
  await extensions.migrateCredits();
  const credits = f.store.pluginCreditStore();
  await credits.migrate();
  const operations = f.store.externalOperationStore();
  await operations.migrate();
  const release = await f.publish();
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store: f.store,
    digester,
    factory: release.factory,
    registry,
  });
  f.own({
    async close() {
      await resolver.close();
      await registry.close();
    },
  });
  const state = {
    actorAllowed: true,
    profileAllowed: true,
    permissionAllowed: true,
    packageAllowed: true,
    ioAllowed: true,
    preflights: 0,
    http: 0,
    quotes: 0,
    beforeActor: null as (() => Promise<void>) | null,
    beforePreflight: null as ((signal: AbortSignal) => Promise<void>) | null,
  };
  const authorization: AuthorizationPort = {
    authorize: async () =>
      state.permissionAllowed
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "fixture_permission_revoked" },
  };
  const io: InstalledPluginExecutionIoConfig = {
    async resolveNetwork() {
      throw new Error("peer_readiness_has_no_run_dispatch");
    },
    async resolveReadinessNetwork(metadata, signal) {
      state.preflights++;
      assert.equal(Object.hasOwn(metadata, "run"), false);
      assert.equal(Object.hasOwn(metadata, "command"), false);
      await state.beforePreflight?.(signal);
      signal.throwIfAborted();
      return state.ioAllowed
        ? {
            baseUrlParameter: "baseUrl",
            paths: [
              { method: "POST", path: "/prompt" },
              { method: "GET", operationPathPrefix: "/history/" },
              { method: "GET", path: "/queue" },
            ],
          }
        : null;
    },
    dns: {
      async resolveAll() {
        return [{ address: "8.8.8.8", family: 4 }];
      },
    },
    transport: {
      async request() {
        state.http++;
        throw new Error("peer_must_not_dispatch_provider");
      },
    },
  };
  const readiness = new InstalledPluginExecutionReadinessOwner({
    configuration: io,
    operations,
  });
  f.own(readiness);
  const scope = f.entries[0]!.scope;
  const resolveProfile = async () => (state.profileAllowed ? scope : null);
  const execution = {
    installRoot: f.installRoot,
    authorization,
    async resolveActor() {
      await state.beforeActor?.();
      return state.actorAllowed ? actor : null;
    },
    authorizePackage: async () =>
      state.packageAllowed ? ("allow" as const) : ("deny" as const),
    executionIo: io,
  };
  async function select(
    state: "enabled" | "disabled",
    digest = f.entries[0]!.packageIdentity.packageDigest,
  ) {
    const pluginId = f.entries[0]!.packageIdentity.pluginId;
    const store = f.store.pluginInstallationStore();
    const current = await store.loadSelection({ scope, pluginId });
    assert.ok(current);
    return store.commitSelection({
      actor,
      scope,
      expectedSelectionRevision: current.revision,
      selection: {
        ...current,
        revision: current.revision + 1,
        state,
        selectedPackageDigest: digest,
        updatedAt: timestamp,
        updatedByActorId: actor.actorId,
        updatedByPrincipalId: actor.principalId,
      },
      receipt: {
        idempotencyKey: `peer-selection-${current.revision}`,
        requestDigest: digester.sha256(
          `peer-selection-${current.revision}-${state}-${digest}`,
        ),
      },
    });
  }
  await select("enabled");
  const peer = await composeInstalledPluginPeer({
    config: { port: 0, token, deadlineMs: 1000, resolveProfile },
    release,
    store: f.store,
    runtimeResolver: resolver,
    execution,
    executionReadiness: readiness,
  });
  f.own(peer);
  function common(operation: string) {
    return {
      protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
      requestId: randomUUID(),
      actor,
      scope,
      operation,
    };
  }
  const identity = (index = 0) => ({
    ...release.registrations[index]!.identity,
    manifestDigest: release.registrations[index]!.manifestDigest,
    implementationDigest: release.registrations[index]!.implementationDigest,
  });
  function request(
    operation: "validateConfiguration" | "readiness",
    index = 0,
  ) {
    return {
      ...common(operation),
      identity: identity(index),
      configuration: f.entries[index]!.configuration,
      ...(operation === "readiness"
        ? { expectedTarget: f.entries[index]!.target }
        : {}),
    };
  }
  async function invoke(input: unknown) {
    const response = await post(peer.origin, input);
    assert.equal(response.status, 200);
    return parseInstalledPluginPeerResponse(await response.json());
  }
  const wireHost: ExtensionHostPort = {
    taskAdmissionMode: () => "installed",
    async validateConfiguration(input) {
      const index = f.entries.findIndex(
        (entry) =>
          entry.configuration.contentDigest ===
          input.configuration.contentDigest,
      );
      assert.ok(index >= 0);
      await invoke({
        ...common("validateConfiguration"),
        identity: identity(index),
        configuration: input.configuration,
      });
    },
    async evaluate(input) {
      const index = f.entries.findIndex(
        (entry) => entry.target.agentVersionId === input.agentVersionId,
      );
      assert.ok(index >= 0);
      const response = await invoke({
        ...common("readiness"),
        identity: identity(index),
        configuration: input.configuration,
        expectedTarget: f.entries[index]!.target,
      });
      assert.equal(response.operation, "readiness");
      if (response.operation !== "readiness")
        throw new Error("peer_fixture_response_invalid");
      return response.result.outcome === "ready"
        ? {
            outcome: "ready",
            target: parseExtensionExecutionTarget(response.result.target),
          }
        : response.result;
    },
  };
  async function activate(index: number) {
    const entry = f.entries[index]!,
      registration = release.registrations[index]!;
    const current = await extensions.loadExtensionActivation({
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: registration.identity.pluginId,
    });
    if (current?.target?.agentVersionId === entry.target.agentVersionId) return;
    await new ExtensionConfigurationApplicationService({
      store: extensions,
      host: wireHost,
      catalog: { list: () => [registration], resolve: () => registration },
      authorization,
      clock: { now: () => timestamp },
      digester,
    }).setActivation(actor, {
      pluginId: registration.identity.pluginId,
      configurationRevision: entry.configuration.revision,
      expectedRevision: current?.revision ?? 0,
      idempotencyKey: `peer-activate-${index}`,
      state: "enabled",
      agentVersionId: entry.target.agentVersionId,
    });
  }
  if (options.activate !== false) await activate(0);
  async function paidSource() {
    const entry = f.entries[0]!;
    const registration = release.registrations[0]!;
    const clock = { now: () => timestamp };
    const ids = new UuidV7ApplicationIdGenerator();
    const catalog = { list: () => [registration], resolve: () => registration };
    await activate(0);
    const creditScope = {
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      poolId: "peer-personal-fixture",
    };
    await credits.grant({
      scope: creditScope,
      grantId: "peer-explicit-test-funding",
      credits: "1000",
    });
    const thread = await new ThreadApplicationService({
      store: f.store,
      authorization,
      clock,
      ids,
      digester,
    }).createThread(actor, {
      kind: "thread.create",
      idempotencyKey: "peer-paid-thread",
      title: null,
    });
    const tasks = new ExtensionTaskApplicationService({
      store: f.store,
      extensions,
      operations,
      host: wireHost,
      catalog,
      authorization,
      clock,
      ids,
      digester,
      creditQuotes: {
        async quoteGeneration() {
          state.quotes++;
          return {
            poolId: creditScope.poolId,
            priceRevision: 1,
            quotedCredits: "30",
          };
        },
      },
    });
    const selected = await f.store
      .pluginInstallationStore()
      .loadSelection({ scope, pluginId: registration.identity.pluginId });
    assert.ok(selected);
    const pin = parsePluginTaskAdmissionPin({
      ...actor,
      ...scope,
      ...registration.identity,
      selectionRevision: selected.revision,
      contributionId: "studio",
      action: "image.generate",
      authorityEpoch: "peer-test-current-authority",
    });
    const command = {
      pluginId: registration.identity.pluginId,
      threadId: thread.state.threadId,
      expectedThreadRevision: thread.state.revision,
      idempotencyKey: "peer-paid-task",
      intent: {
        kind: "generate" as const,
        input: { prompt: "An actual peer-paid provenance fixture" },
      },
    };
    const authority = {
      async assertCurrent() {
        const current = await f.store
          .pluginInstallationStore()
          .loadSelection({ scope, pluginId: pin.pluginId });
        assert.equal(current?.revision, pin.selectionRevision);
        assert.equal(current?.state, "enabled");
      },
    };
    const result = await tasks.createTaskFromPlugin(
      actor,
      command,
      pin,
      authority,
    );
    const replay = await tasks.createTaskFromPlugin(
      actor,
      command,
      pin,
      authority,
    );
    assert.equal(replay.binding.runId, result.binding.runId);
    assert.equal(state.quotes, 1);
    const admission = await extensions.loadPluginTaskAdmission(result.binding);
    assert.ok(admission);
    const operationId = randomUUID();
    await operations.reserveExternalOperation({
      tenantId: actor.tenantId,
      runId: result.binding.runId,
      bindingDigest: result.binding.bindingDigest,
      operationId,
      executionId: "peer-source-operation",
      idempotencyKey: "peer-source-operation",
      actionDigest: digester.sha256("explicit-provider-fixture-action"),
      requestDigest: digester.sha256("explicit-provider-fixture-request"),
      correlationId: operationId,
      createdAt: timestamp,
    });
    return { admission, binding: result.binding, operationId };
  }
  return {
    ...f,
    release,
    registry,
    resolver,
    readiness,
    scope,
    state,
    peer,
    common,
    identity,
    request,
    invoke,
    select,
    activate,
    paidSource,
    execution,
    resolveProfile,
    io,
  };
}
