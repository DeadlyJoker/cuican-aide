import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import {
  ApplicationError,
  prepareProjectHistoricalQueryResolver,
  ExtensionTaskApplicationService,
  ExtensionReadApplicationService,
  PluginUiCommittedTaskAuthority,
  ProjectGenerationReadApplicationService,
} from "@crewon/application";
import {
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  parseInstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";
import {
  bindInstalledPluginRequestOwner,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import { InstalledPluginProjectHistoricalQueryOwner } from "./installed-plugin-project-historical-query-owner.ts";
import { InstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import {
  installedProjectHistoricalQueryFixture,
  actor,
  queryAction,
} from "./installed-plugin-project-historical-query-owner.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { createProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";
import { createProductionProjectGenerationReadPluginRuntime } from "./production-project-generation-read-plugin-runtime.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";

/** Real HTTP identity/request owner, strict original peer transport, actual Node B and one SQL history.
 * Identity/PDP and peer response transport are explicit fixtures, not a live Worker or supplier. */
export async function installedProjectHistoricalQueryHttpFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: Readonly<{ packageDirectory?: string }> = {},
) {
  const f = await installedProjectHistoricalQueryFixture(t, backend, options);
  const state = {
    identityAllowed: true,
    currentActor: { ...actor },
    peerCalls: [] as string[],
    profileCalls: 0,
    queryEntered: null as (() => void) | null,
    queryGate: null as Promise<void> | null,
  };
  const headers = {
    "authorization": "Bearer project-query-http-fixture-token",
    "origin": "https://query.fixture.example",
    "x-crewon-bff-authorization": "Bearer project-query-http-bff-fixture-token",
  };
  const identity = new ProductionControlApiIdentity({
    trustedBff: {
      verify(request) {
        if (
          request.serviceAuthorization !== headers["x-crewon-bff-authorization"]
        )
          throw new ApplicationError("authorization", "fixture_bff_denied");
      },
    },
    tokens: {
      async verify({ accessToken, signal }) {
        signal.throwIfAborted();
        if (
          accessToken !== "project-query-http-fixture-token" ||
          !state.identityAllowed
        )
          throw new Error("fixture-query-token-denied");
        return {
          issuer: "https://identity.query.fixture.example",
          audience: ["project-query-control"],
          issuedAt: "2026-10-04T00:00:00.000Z",
          expiresAt: "2026-10-04T00:05:00.000Z",
          ...state.currentActor,
        };
      },
    },
    expectedIssuer: "https://identity.query.fixture.example",
    expectedAudience: "project-query-control",
    timeoutMs: 1000,
    cacheTtlMs: 1,
    now: () => Date.parse("2026-10-04T00:01:00.000Z"),
  });
  const configuration = await f.extensions.loadExtensionConfiguration({
    ...actor,
    pluginId: f.oldPin.pluginId,
    revision: f.generation.binding.configurationRevision,
  });
  assert.ok(configuration);
  const registration = f.taskDependencies.catalog.resolve({
    pluginId: f.oldPin.pluginId,
    pluginVersion: f.oldPin.version,
  });
  assert.ok(registration);
  const originalIdentity = {
    pluginId: f.oldPin.pluginId,
    publisherId: f.oldPin.publisherId,
    version: f.oldPin.version,
    packageDigest: f.oldPin.packageDigest,
    manifestDigest: configuration.manifestDigest,
    implementationDigest: configuration.implementationDigest,
  };
  const peer = new InstalledPluginPeerClient(
    {
      origin: "http://127.0.0.1:18349",
      token: "query-peer-fixture-token-000000000000000000000",
      deadlineMs: 1500,
    },
    {
      fetch: async (_url, init) => {
        const request = parseInstalledPluginPeerRequest(
          JSON.parse(String(init?.body)),
        );
        assert.deepEqual(request.actor, actor);
        assert.deepEqual(request.scope, f.profile);
        state.peerCalls.push(request.operation);
        const common = {
          protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
          requestId: request.requestId,
          operation: request.operation,
          actor: request.actor,
          scope: request.scope,
        };
        if (request.operation === "catalog")
          return Response.json({
            ...common,
            entries: [
              {
                identity: originalIdentity,
                manifest: registration.manifest,
                configuration,
                configuredTarget: f.generation.binding.target,
              },
            ],
          });
        if (request.operation === "queryResolveRegistration") {
          assert.equal(
            request.expectedSource.admission.packageDigest,
            f.oldPin.packageDigest,
          );
          assert.equal(
            request.expectedSource.binding.runId,
            f.generation.binding.runId,
          );
          return Response.json({
            ...common,
            expectedSource: request.expectedSource,
            registration: {
              identity: originalIdentity,
              manifest: registration.manifest,
            },
          });
        }
        if (request.operation === "queryReadiness") {
          assert.deepEqual(request.identity, originalIdentity);
          assert.equal(
            request.configuration.contentDigest,
            configuration.contentDigest,
          );
          assert.deepEqual(request.expectedTarget, f.generation.binding.target);
          state.queryEntered?.();
          await state.queryGate;
          return Response.json({
            ...common,
            identity: originalIdentity,
            configurationDigest: configuration.contentDigest,
            expectedSource: request.expectedSource,
            expectedTarget: request.expectedTarget,
            result: { outcome: "ready", target: f.generation.binding.target },
          });
        }
        if (request.operation === "validateConfiguration")
          return Response.json({
            ...common,
            identity: request.identity,
            configurationDigest: configuration.contentDigest,
          });
        throw new Error("unexpected-query-peer-operation");
      },
    },
  );
  const requests = new InstalledPluginRequestOwner({
    identity,
    profiles: {
      async resolve() {
        state.profileCalls++;
        return f.profile;
      },
    },
    peer,
  });
  const authorization = {
    async authorize(
      input: Parameters<typeof f.dependencies.authorization.authorize>[0],
    ) {
      await requests.assertCurrent();
      const result = await f.dependencies.authorization.authorize(input);
      await requests.assertCurrent();
      return result;
    },
  };
  const businessAuthorization = {
    async authorize(
      input: Parameters<typeof f.taskDependencies.authorization.authorize>[0],
    ) {
      await requests.assertCurrent();
      const result = await f.taskDependencies.authorization.authorize(input);
      await requests.assertCurrent();
      return result;
    },
  };
  const reads = new ExtensionReadApplicationService({
    runs: f.first.parent,
    agentVersions: f.first.parent,
    extensions: f.extensions,
    operations: f.first.parent.externalOperationStore(),
    catalog: requests.catalog,
    host: requests.host,
    authorization: businessAuthorization,
    digester: extensionStoreDigester,
  });
  bindInstalledPluginRequestOwner(reads, requests, {
    preparation: "configuration",
  });
  const generationReads = new ProjectGenerationReadApplicationService({
    projects: f.projectService,
    tasks: reads,
    extensions: f.extensions,
    digester: extensionStoreDigester,
  });
  const tasks = new ExtensionTaskApplicationService({
    ...f.taskInputs,
    catalog: requests.catalog,
    host: requests.host,
    pluginQueryHost: requests.pluginQueryHost,
    authorization: businessAuthorization,
    projectGenerationReads: generationReads,
  });
  const committed = new PluginUiCommittedTaskAuthority({
    extensions: f.extensions,
    runs: f.first.parent,
    digester: extensionStoreDigester,
    projectHistoricalQueries: {
      publications: [f.publication],
      projects: f.projects,
      operations: f.operations,
    },
  });
  const taskOwner = new InstalledPluginTaskActionOwner({
    ...f.dependencies,
    tasks,
    committedTasks: committed,
    authorization,
    resolveActor: (owner, signal) => requests.resolveActor(owner, signal),
  });
  const uiConfiguration = parseProductionPluginUiConfiguration({
    installRoot: f.installRoot,
    profileAuthority: {
      url: "https://query.fixture.example/profile",
      serviceToken: "query-profile-fixture-token-00000000000000000",
    },
    policyAuthority: {
      url: "https://query.fixture.example/policy",
      serviceToken: "query-policy-fixture-token-000000000000000000",
    },
    publications: [
      {
        pluginId: f.sourceId,
        packageDigest: f.source.packageDigest,
        publisherId: f.source.descriptor.publisherId,
        publicAssets: [f.source.descriptor.entrypoints.ui!.path],
      },
    ],
    timeoutMs: 1500,
  });
  const authorityFetch: typeof fetch = async (url, init) => {
    init?.signal?.throwIfAborted();
    if (String(url).endsWith("/profile")) return Response.json(f.profile);
    const input = JSON.parse(String(init?.body));
    const business = input.resource.pluginId === f.sourceId;
    return Response.json(
      (business ? f.state.sourceDenied : f.state.targetDenied)
        ? { outcome: "deny", reasonCode: "fixture-query-denied" }
        : {
            outcome: "allow",
            authorityEpoch: business
              ? f.state.sourceEpoch
              : f.state.targetEpoch,
          },
    );
  };
  const metadata =
    options.packageDirectory === undefined
      ? undefined
      : createProductionCreativeProjectPluginRuntime({
          projects: {
            service: f.projectService,
            pluginUi: { publications: [f.publication.source] },
          },
          ui: uiConfiguration,
          identity,
          fetch: authorityFetch,
        });
  const readRuntime =
    options.packageDirectory === undefined
      ? undefined
      : createProductionProjectGenerationReadPluginRuntime({
          configuration: { publications: [f.publication.source] },
          reads: generationReads,
          taskReads: reads,
          ui: uiConfiguration,
          identity,
          fetch: authorityFetch,
          ...(metadata === undefined
            ? {}
            : { hostUiServices: metadata.hostUiServices }),
        });
  const queryOwner = new InstalledPluginProjectHistoricalQueryOwner(
    {
      ...f.dependencies,
      tasks,
      taskOwner,
      committedTasks: committed,
      resolver: prepareProjectHistoricalQueryResolver(
        {
          ...f.taskInputs,
          catalog: requests.catalog,
          host: requests.host,
          pluginQueryHost: requests.pluginQueryHost,
          authorization: businessAuthorization,
          projectGenerationReads: generationReads,
        },
        [f.publication],
      ),
      authorization,
      resolveActor: (owner, signal) => requests.resolveActor(owner, signal),
      requestSignal: () => requests.currentSignal(),
    },
    readRuntime?.hostUiServices ?? metadata?.hostUiServices,
  );
  const ui = createProductionPluginUiRuntime(
    {
      configuration: uiConfiguration,
      ownedTaskActions: taskOwner,
      ownedProjectHistoricalQueryActions: queryOwner,
      ...(metadata === undefined
        ? {}
        : { ownedCreativeProjectActions: metadata.owner }),
      ...(readRuntime === undefined
        ? {}
        : { ownedProjectGenerationReadActions: readRuntime.owner }),
    },
    {
      ledger: f.ledger,
      clock: f.dependencies.clock,
      fetch: authorityFetch,
    },
  );
  const service = createProductionPluginUiRequestService({
    ui: ui.service,
    taskRequests: requests,
    historicalQueries: queryOwner,
    ...(metadata === undefined ? {} : { projects: metadata }),
    ...(readRuntime === undefined
      ? {}
      : { projectGenerationReads: readRuntime }),
  });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const response = errorResponse(error, request.id);
    return reply.code(response.statusCode).send(response.body);
  });
  registerPluginControlRoutes(app, { identity, pluginUi: service });
  t.after(async () => {
    await app.close();
    await requests.close();
    await ui.close();
    await peer.close();
    await metadata?.close();
    await readRuntime?.close();
  });
  const selected = await f.ledger.loadSelection({
    scope: f.profile,
    pluginId: f.sourceId,
  });
  assert.ok(selected);
  const mount = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts",
    headers,
    payload: {
      pluginId: f.sourceId,
      contributionId: "workbench",
      expectedSelectionRevision: selected.revision,
      expectedPackageDigest: f.source.packageDigest,
    },
  });
  assert.equal(mount.statusCode, 200, mount.body);
  const lease = mount.json();
  const invoke = (
    input = f.request,
    action: string = queryAction,
    requestHeaders = headers,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers: requestHeaders,
      payload: { action, input },
    });
  return {
    ...f,
    httpState: state,
    identity,
    requests,
    queryOwner,
    ui,
    app,
    headers,
    httpLease: lease,
    httpInvoke: invoke,
    metadata,
    readRuntime,
  };
}
