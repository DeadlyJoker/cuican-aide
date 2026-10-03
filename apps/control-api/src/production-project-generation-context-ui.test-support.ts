import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import { PROJECT_GENERATION_CONTEXT_UI_ACTIONS } from "@crewon/contracts/plugins";
import { errorResponse } from "./control-api-errors.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import {
  installedGenerationFixture,
  actor,
} from "./installed-plugin-project-generation-owner.test-support.ts";
import { projectGenerationHttpsAuthority } from "./production-project-generation-ui.integration.test-support.ts";
import {
  PRODUCTION_BFF_AUTHORIZATION_HEADER,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";
import { createProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";

function contextIdentity() {
  const origin = "https://project-generation-context.fixture.test";
  const accessToken = `context-session-fixture-${"s".repeat(32)}`;
  const bffToken = `context-bff-fixture-${"b".repeat(32)}`;
  const state = { tokenAlive: true };
  const identity = new ProductionControlApiIdentity({
    trustedBff: new StaticTrustedBffRequestVerifier({
      serviceToken: bffToken,
      allowedOrigins: [origin],
      allowedRemoteAddresses: ["127.0.0.1"],
    }),
    tokens: {
      verify: async (input) => {
        assert.equal(input.accessToken, accessToken);
        if (!state.tokenAlive) return null;
        const now = Date.now();
        return {
          ...actor,
          issuer: "https://context-identity.fixture.test",
          audience: "crewon-generation-context",
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        };
      },
    },
    expectedIssuer: "https://context-identity.fixture.test",
    expectedAudience: "crewon-generation-context",
    timeoutMs: 1000,
    cacheTtlMs: 0,
  });
  return {
    identity,
    state,
    headers: {
      "authorization": `Bearer ${accessToken}`,
      origin,
      "x-csrf-token": `context-csrf-fixture-${"c".repeat(32)}`,
      [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${bffToken}`,
    },
  };
}

/** Actual source HTTP/TLS/SQL/Host chain. Peer readiness and human session are explicit test ports. */
export async function generationContextHttpFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: Readonly<{ generationOwner?: "disabled" }> = {},
) {
  const disabled = options.generationOwner === "disabled";
  const f = await installedGenerationFixture(t, backend, {
    contexts: true,
    ...(disabled
      ? { serviceRequirements: "optional" as const, metadata: true }
      : {}),
  });
  const authority = await projectGenerationHttpsAuthority(t, {
    actor,
    profile: f.profile,
    sourceId: f.sourceId,
    sourceEpoch: () => f.state.sourceEpoch,
    targetEpoch: () => f.state.targetEpoch,
  });
  const authentication = contextIdentity();
  const configuration = parseProductionPluginUiConfiguration({
    installRoot: f.installRoot,
    profileAuthority: authority.profileAuthority,
    policyAuthority: authority.policyAuthority,
    publications: [
      {
        pluginId: f.sourceId,
        publisherId: f.source.descriptor.publisherId,
        packageDigest: f.source.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    timeoutMs: 1000,
  });
  const metadata = disabled
    ? createProductionCreativeProjectPluginRuntime({
        projects: {
          service: f.projectService,
          pluginUi: {
            publications: [
              {
                pluginId: f.sourceId,
                packageDigest: f.source.packageDigest,
                contributionId: "workbench",
              },
            ],
          },
        },
        ui: configuration,
        identity: authentication.identity,
        fetch: authority.fetch,
      })
    : undefined;
  const runtime = createProductionPluginUiRuntime(
    {
      configuration,
      ...(disabled
        ? {
            ownedCreativeProjectActions: metadata!.owner,
            hostUiServices: metadata!.hostUiServices,
          }
        : {
            ownedTaskActions: f.taskOwner,
            ownedProjectGenerationActions: f.owner,
          }),
    },
    { ledger: f.ledger, clock: f.dependencies.clock, fetch: authority.fetch },
  );
  let preparations = 0;
  const requests = new InstalledPluginRequestOwner({
    identity: authentication.identity,
    profiles: f.dependencies.profiles,
    peer: {
      prepare: async (input) => {
        preparations++;
        assert.deepEqual(input, { actor, scope: f.profile });
        return {
          catalog: f.taskInputs.catalog,
          host: f.taskInputs.host,
          pluginQueryHost: {
            resolveRegistration: async () => null,
            evaluate: async () => ({
              outcome: "unavailable" as const,
              reasonCode: "extension_runtime_unavailable" as const,
            }),
          },
        };
      },
    },
  });
  const ui = createProductionPluginUiRequestService({
    ui: runtime.service,
    ...(disabled
      ? { projects: metadata }
      : { taskRequests: requests, projectGenerations: f.owner }),
  });
  const app = Fastify({ trustProxy: false });
  app.setErrorHandler((error, req, reply) => {
    const result = errorResponse(error, req.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerPluginControlRoutes(app, {
    identity: authentication.identity,
    pluginUi: ui,
  });
  app.addHook("onClose", async () => {
    await runtime.close();
    await requests.close();
    await metadata?.close();
  });
  t.after(() => app.close());
  const opened = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts",
    headers: authentication.headers,
    payload: {
      pluginId: f.sourceId,
      contributionId: "workbench",
      expectedSelectionRevision: f.sourceEnabled.selection.revision,
      expectedPackageDigest: f.source.packageDigest,
    },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  const lease = opened.json<{ mountRef: string }>();
  const invoke = (
    payload: Record<string, unknown> = {
      action: PROJECT_GENERATION_CONTEXT_UI_ACTIONS[0],
      input: { reference: f.reference },
    },
    headers: Record<string, string> = authentication.headers,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers,
      payload,
    });
  return {
    ...f,
    authority,
    authentication,
    runtime,
    requests,
    metadata,
    app,
    httpLease: lease,
    invokeHttp: invoke,
    preparations: () => preparations,
  };
}
