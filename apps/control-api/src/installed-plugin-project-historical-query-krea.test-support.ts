import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  CreativeProjectApplicationService,
  ExtensionTaskApplicationService,
  type AuthorizationPort,
  type CreativeProjectAuthorizationPort,
  type PluginUiAuthorizationPort,
} from "@crewon/application";
import {
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  PROJECT_HISTORICAL_QUERY_UI_ACTIONS,
  parseInstalledPluginPeerRequest,
  parseInstalledPluginPeerResponse,
} from "@crewon/contracts/plugins";
import {
  parseProjectHistoricalQueryPublication,
  parsePluginTaskAdmission,
  parseExtensionRunBinding,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  kreaExecutionFixture,
  kreaPrompt,
} from "../../runtime-worker/src/installed-plugin-krea2.integration.test-support.ts";
import {
  actor,
  scope,
  digester,
} from "../../runtime-worker/src/installed-plugin-business-execution.integration.test-support.ts";
import { startInstalledPluginPeerServer } from "../../runtime-worker/src/plugins/installed-plugin-peer-server.ts";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import { createProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";
import { createProductionProjectGenerationReadPluginRuntime } from "./production-project-generation-read-plugin-runtime.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { errorResponse } from "./control-api-errors.ts";

/** Original installed Krea bytes + Kernel/SQL + physical peer HTTP. Named identity/model/IO only.
 * The handler delegates actual Worker hosts; it does not cover LoadedRelease/PeerService construction or Main. */
export async function historicalKreaFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const sourceDirectory =
    process.env.CREWON_TEST_PROJECT_HISTORY_SHORT_PLUGIN_DIR;
  assert.ok(
    sourceDirectory,
    "an independently built current Short18 package is required",
  );
  const f = await kreaExecutionFixture(t, backend, { queryTasks: true });
  assert.ok(f.queryHost);
  const clock = { now: () => new Date().toISOString() },
    ids = { nextId: () => randomUUID() };
  const authorization: AuthorizationPort = {
    authorize: async (input) => {
      assert.deepEqual(input.actor, actor);
      return { outcome: "allow" };
    },
  };
  const projectAuthorization: CreativeProjectAuthorizationPort = {
    authorize: async (input) => {
      assert.deepEqual(input.actor, actor);
      return { outcome: "allow" };
    },
  };
  const projects = f.store.creativeProjectStore();
  await projects.migrate();
  await f.extensions.migrateProjectGenerations();
  const projectService = new CreativeProjectApplicationService({
    store: projects,
    authorization: projectAuthorization,
    clock,
    ids,
    digester,
  });
  const project = await projectService.createProject(actor, {
    title: "Original installed Krea history",
    briefText: "Named saved narrative",
    idempotencyKey: "historical-krea-project",
  });
  const concept = await projectService.createConcept(actor, {
    projectId: project.project.projectId,
    expectedProjectRevision: project.project.revision,
    briefRevision: project.brief.briefRevision,
    name: "Saved portrait",
    prompt: kreaPrompt,
    idempotencyKey: "historical-krea-concept",
  });
  const originalRequest = await f.prepareTask("original-project-generation");
  const registration = f.entry.registration;
  const catalog = {
    list: () => [registration],
    resolve: ({
      pluginId,
      pluginVersion,
    }: {
      pluginId: string;
      pluginVersion: string;
    }) =>
      pluginId === registration.identity.pluginId &&
      pluginVersion === registration.identity.version
        ? registration
        : null,
  };
  const generationTasks = new ExtensionTaskApplicationService({
    store: f.store,
    extensions: f.extensions,
    operations: f.operations,
    catalog,
    host: f.host,
    authorization,
    clock,
    ids,
    digester,
    creativeProjects: { store: projects, authorization: projectAuthorization },
    creditQuotes: {
      async quoteGeneration() {
        f.controls.quotes++;
        return {
          poolId: f.creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        };
      },
    },
  });
  const original = await generationTasks.createProjectTaskFromPlugin(
    actor,
    originalRequest.command,
    originalRequest.pin,
    {
      projectId: concept.project.projectId,
      assetId: concept.asset.assetId,
      assetRevision: concept.assetRevision.assetRevision,
      expectedProjectRevision: concept.project.revision,
      expectedAssetMetadataRevision: concept.asset.revision,
    },
    { assertCurrent: async () => {}, assertActive() {} },
  );
  const first = await f.openWorker();
  assert.deepEqual(await first.worker.wake(), {
    kind: "completed",
    runId: original.binding.runId,
  });
  assert.equal((await first.worker.wake()).kind, "idle");
  await f.closeWorker();
  const operations = await f.operations.listExternalOperations({
    tenantId: original.binding.tenantId,
    runId: original.binding.runId,
    bindingDigest: original.binding.bindingDigest,
    limit: 16,
  });
  assert.equal(operations.operations.length, 1);
  const operation = operations.operations[0]!;
  assert.equal(operation.status, "submitted");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.method, "POST");
  const source = await installLocalPluginPackage({
    directory: sourceDirectory,
    installRoot: f.pkg.input.installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  assert.equal(source.descriptor.pluginId, "crewon.short-drama");
  assert.equal(source.descriptor.version, "18.0.0");
  const installed = await f.installations.recordInstalledPackage(
    installationRecipe("history-current-source-install", {
      actor,
      scope,
      pluginId: source.descriptor.pluginId,
      publisherId: source.descriptor.publisherId,
      version: source.descriptor.version,
      packageDigest: source.packageDigest,
      at: clock.now(),
    }),
  );
  const selected = await f.installations.commitSelection(
    selectionRecipe(installed.selection, "history-current-source-enable", {
      actor,
      packageDigest: source.packageDigest,
      at: clock.now(),
    }),
  );
  const publication = parseProjectHistoricalQueryPublication({
    source: {
      pluginId: source.descriptor.pluginId,
      packageDigest: source.packageDigest,
      contributionId: "workbench",
    },
    target: {
      ...registration.identity,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      contributionId: "studio",
      action: "image.query",
    },
  });
  const queryThread = await f.prepareTask("historical-query-thread");
  const request = {
    reference: {
      projectId: concept.project.projectId,
      assetId: concept.asset.assetId,
      assetRevision: concept.assetRevision.assetRevision,
    },
    operationId: operation.operationId,
    threadId: queryThread.command.threadId,
    expectedThreadRevision: queryThread.command.expectedThreadRevision,
    idempotencyKey: "historical-krea-query-original-key",
  };
  const peerCalls: string[] = [];
  const queryHost = f.queryHost;
  const peerServer = await startInstalledPluginPeerServer({
    port: 0,
    token: "historical-krea-owned-peer-token-000000000001",
    rateLimit: 1000,
    service: {
      async handle(input, signal) {
        const r = parseInstalledPluginPeerRequest(input);
        signal.throwIfAborted();
        assert.deepEqual(r.actor, actor);
        assert.deepEqual(r.scope, scope);
        peerCalls.push(r.operation);
        const common = {
          protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
          requestId: r.requestId,
          operation: r.operation,
          actor: r.actor,
          scope: r.scope,
        };
        const identity = {
          ...registration.identity,
          manifestDigest: registration.manifestDigest,
          implementationDigest: registration.implementationDigest,
        };
        if (r.operation === "catalog")
          return parseInstalledPluginPeerResponse({
            ...common,
            entries: [
              {
                identity,
                manifest: registration.manifest,
                configuration: f.entry.configuration,
                configuredTarget: original.binding.target,
              },
            ],
          });
        if (r.operation === "queryResolveRegistration") {
          const actual = await queryHost.resolveRegistration({
            actor,
            source: {
              admission: parsePluginTaskAdmission(r.expectedSource.admission),
              binding: parseExtensionRunBinding(
                r.expectedSource.binding,
                digester,
              ),
              operationId: r.expectedSource.operationId,
            },
          });
          signal.throwIfAborted();
          return parseInstalledPluginPeerResponse({
            ...common,
            expectedSource: r.expectedSource,
            registration:
              actual === null ? null : { identity, manifest: actual.manifest },
          });
        }
        if (r.operation === "queryReadiness") {
          const actual = await queryHost.resolveRegistration({
            actor,
            source: {
              admission: parsePluginTaskAdmission(r.expectedSource.admission),
              binding: parseExtensionRunBinding(
                r.expectedSource.binding,
                digester,
              ),
              operationId: r.expectedSource.operationId,
            },
          });
          assert.ok(actual);
          const result = await queryHost.evaluate({
            actor,
            source: {
              admission: parsePluginTaskAdmission(r.expectedSource.admission),
              binding: parseExtensionRunBinding(
                r.expectedSource.binding,
                digester,
              ),
              operationId: r.expectedSource.operationId,
            },
            registration: actual,
            configuration: parseExtensionConfiguration(
              r.configuration,
              digester,
            ),
            expectedTarget: parseExtensionExecutionTarget(r.expectedTarget),
          });
          signal.throwIfAborted();
          return parseInstalledPluginPeerResponse({
            ...common,
            identity,
            configurationDigest: r.configuration.contentDigest,
            expectedSource: r.expectedSource,
            expectedTarget: r.expectedTarget,
            result,
          });
        }
        if (r.operation === "validateConfiguration") {
          await f.host.validateConfiguration({
            actor,
            registration,
            configuration: parseExtensionConfiguration(
              r.configuration,
              digester,
            ),
          });
          return parseInstalledPluginPeerResponse({
            ...common,
            identity,
            configurationDigest: r.configuration.contentDigest,
          });
        }
        throw new Error("unexpected_historical_fixture_peer_operation");
      },
    },
  });
  t.after(() => peerServer.close());
  const peer = new InstalledPluginPeerClient({
    origin: peerServer.origin,
    token: "historical-krea-owned-peer-token-000000000001",
    deadlineMs: 5000,
  });
  t.after(() => peer.close());
  const headers = {
    "authorization": "Bearer historical-krea-control-fixture-token",
    "origin": "https://history.fixture.example",
    "x-crewon-bff-authorization": "Bearer historical-krea-bff-fixture-token",
  };
  const identity = new ProductionControlApiIdentity({
    trustedBff: {
      verify(value) {
        assert.equal(
          value.serviceAuthorization,
          headers["x-crewon-bff-authorization"],
        );
      },
    },
    tokens: {
      async verify({ accessToken, signal }) {
        signal.throwIfAborted();
        if (accessToken !== "historical-krea-control-fixture-token")
          throw new ApplicationError(
            "authorization",
            "fixture_identity_denied",
          );
        return {
          issuer: "https://identity.history.fixture.example",
          audience: ["historical-krea-control"],
          issuedAt: "2026-10-06T00:00:00.000Z",
          expiresAt: "2026-10-06T00:05:00.000Z",
          ...actor,
        };
      },
    },
    expectedIssuer: "https://identity.history.fixture.example",
    expectedAudience: "historical-krea-control",
    timeoutMs: 1000,
    cacheTtlMs: 1,
    now: () => Date.parse("2026-10-06T00:01:00.000Z"),
  });
  const requests = new InstalledPluginRequestOwner({
    identity,
    profiles: { resolve: async () => scope },
    peer,
  });
  t.after(() => requests.close());
  const uiAuthorization: PluginUiAuthorizationPort = {
    authorize: async (input) => {
      assert.deepEqual(input.actor, actor);
      return {
        outcome: "allow",
        authorityEpoch: "historical-krea-named-ui-policy",
      };
    },
  };
  const prepared = await prepareCreativeProjects(f.store, {
    authorization: projectAuthorization,
    generationReads: { version: "crewon.project-generation-read.v1" },
    pluginUi: { publications: [publication.source] },
    historicalQueries: {
      version: "crewon.desktop-project-historical-query.v1",
      publications: [publication],
    },
  });
  assert.ok(prepared);
  const uiConfig = parseProductionPluginUiConfiguration({
    installRoot: f.pkg.input.installRoot,
    profileAuthority: {
      url: "https://history.fixture.example/profile",
      serviceToken: "historical-krea-profile-fixture-token-0000001",
    },
    policyAuthority: {
      url: "https://history.fixture.example/policy",
      serviceToken: "historical-krea-policy-fixture-token-00000001",
    },
    publications: [
      {
        pluginId: source.descriptor.pluginId,
        publisherId: source.descriptor.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: [source.descriptor.entrypoints.ui!.path],
      },
    ],
    timeoutMs: 5000,
  });
  const authorityFetch: typeof fetch = async (url, init) => {
    init?.signal?.throwIfAborted();
    return Response.json(
      String(url).endsWith("/profile")
        ? scope
        : {
            outcome: "allow",
            authorityEpoch: "historical-krea-named-ui-policy",
          },
    );
  };
  const metadata = createProductionCreativeProjectPluginRuntime({
    projects: prepared,
    ui: uiConfig,
    identity,
    fetch: authorityFetch,
  });
  assert.ok(metadata);
  t.after(() => metadata.close());
  const core = await createInstalledPluginTaskRuntimeCore({
    store: f.store,
    requests,
    installRoot: f.pkg.input.installRoot,
    maximumPackages: 8,
    publications: [publication.source],
    profiles: { resolve: async () => scope },
    businessAuthorization: authorization,
    uiAuthorization,
    authorizePackage: async () => "allow",
    creditQuotes: {
      async quoteGeneration() {
        throw new Error("historical_query_must_not_quote");
      },
    },
    clock,
    ids,
    digester,
    creativeProjects: prepared,
    metadataHostUiServices: metadata.hostUiServices,
  });
  t.after(() => core.close());
  assert.ok(core.historicalQueries);
  assert.ok(core.projectGenerationReads);
  const readRuntime = createProductionProjectGenerationReadPluginRuntime({
    configuration: { publications: [publication.source] },
    reads: core.projectGenerationReads,
    taskReads: core.extensionReads,
    ui: uiConfig,
    identity,
    fetch: authorityFetch,
    hostUiServices: core.historicalQueries.hostUiServices,
  });
  t.after(() => readRuntime.close());
  const ui = createProductionPluginUiRuntime(
    {
      configuration: uiConfig,
      ownedTaskActions: core.owner,
      ownedProjectHistoricalQueryActions: core.historicalQueries,
      ownedCreativeProjectActions: metadata.owner,
      ownedProjectGenerationReadActions: readRuntime.owner,
    },
    { ledger: f.installations, clock, fetch: authorityFetch },
  );
  t.after(() => ui.close());
  const service = createProductionPluginUiRequestService({
    ui: ui.service,
    taskRequests: requests,
    historicalQueries: core.historicalQueries,
    projects: metadata,
    projectGenerationReads: readRuntime,
  });
  const errors: string[][] = [];
  const app = Fastify();
  app.setErrorHandler((e, r, reply) => {
    const chain: string[] = [];
    let value: unknown = e;
    for (let i = 0; i < 8 && value instanceof Error; i++) {
      const current = value as Error & { code?: unknown; cause?: unknown };
      chain.push(
        typeof current.code === "string"
          ? current.code
          : /^[a-z0-9_]+$/u.test(current.message)
            ? current.message
            : current.name,
      );
      value = current.cause;
    }
    errors.push(chain);
    const response = errorResponse(e, r.id);
    return reply.code(response.statusCode).send(response.body);
  });
  registerPluginControlRoutes(app, { identity, pluginUi: service });
  t.after(() => app.close());
  const mounting = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts",
    headers,
    payload: {
      pluginId: source.descriptor.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: selected.selection.revision,
      expectedPackageDigest: source.packageDigest,
    },
  });
  assert.equal(mounting.statusCode, 200, mounting.body);
  const lease = mounting.json();
  const invoke = (input = request) =>
    app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers,
      payload: { action: PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0], input },
    });
  return {
    ...f,
    source,
    publication,
    request,
    original,
    operation,
    peerCalls,
    core,
    app,
    invoke,
    lease,
    errors,
  };
}
