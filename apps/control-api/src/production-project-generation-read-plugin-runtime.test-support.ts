import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import type {
  ActorContext,
  InvokePluginUiActionCommand,
} from "@crewon/application";
import {
  installLocalPluginPackage,
  verifyLocalPluginPackage,
} from "@crewon/plugin-host";
import { PostgresDomainStore } from "@crewon/store";
import { parseProjectGenerationReadUiActionResponse } from "@crewon/contracts/plugins";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { generationReadHttpFixture } from "./project-generation-read-route.test-support.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import {
  bindInstalledPluginRequestOwner,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { createProductionProjectGenerationReadPluginRuntime } from "./production-project-generation-read-plugin-runtime.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { errorResponse } from "./control-api-errors.ts";
import { createProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";
import { requestContext } from "./request-context.ts";

/** Actual installed UI bytes, SQL saved-source/paid-history reader, original current request owner and HTTP route.
 * Authority transport/token verifier are explicit test ports. Reading never calls a provider or funds a new task. */
export async function generationReadPluginFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: Readonly<{ packageDirectory?: string }> = {},
) {
  if (backend === "postgres") {
    const open = PostgresDomainStore.open.bind(PostgresDomainStore);
    t.mock.method(
      PostgresDomainStore,
      "open",
      (input: Parameters<typeof open>[0]) => open({ ...input, maxPoolSize: 1 }),
    );
  }
  const history = await generationReadHttpFixture(t, backend);
  const packageSource = await productionSourceFixture(t);
  const delivered =
    options.packageDirectory === undefined
      ? await packageSource.source("read-ui", {
          pluginId: "test.generation-history",
          uiOnly: true,
          requiredService: "crewon.project-generation-reads",
        })
      : await (async () => {
          const pkg = await verifyLocalPluginPackage({
            directory: options.packageDirectory!,
          });
          return {
            ...pkg,
            sourceId: "actual-short-drama-4",
            pluginId: pkg.descriptor.pluginId,
            publisherId: pkg.descriptor.publisherId,
            version: pkg.descriptor.version,
          };
        })();
  if (options.packageDirectory === undefined)
    await writeFile(
      join(delivered.directory, "crewon.plugin.json"),
      JSON.stringify({
        ...delivered.descriptor,
        requires: [
          {
            service: "crewon.project-generation-reads",
            apiVersion: "1",
            optional: true,
          },
        ],
      }),
    );
  const installed = await installLocalPluginPackage({
    directory: delivered.directory,
    installRoot: packageSource.installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const source = {
    ...delivered,
    descriptor: installed.descriptor,
    packageDigest: installed.packageDigest,
  };
  const profile = {
    tenantId: history.actor.tenantId,
    spaceId: history.actor.spaceId,
    profileId: history.enabled.selection.profileId,
  };
  const publication = {
    pluginId: installed.descriptor.pluginId,
    packageDigest: installed.packageDigest,
    contributionId: "workbench",
  };
  const ledger = history.first.parent.pluginInstallationStore();
  const saved = await ledger.recordInstalledPackage(
    installationRecipe("generation-ui-source", {
      scope: profile,
      actor: history.actor,
      pluginId: installed.descriptor.pluginId,
      publisherId: installed.descriptor.publisherId,
      version: installed.descriptor.version,
      packageDigest: installed.packageDigest,
    }),
  );
  const selected = await ledger.commitSelection(
    selectionRecipe(saved.selection, "generation-ui-enable", {
      actor: history.actor,
    }),
  );
  const state = {
    actor: history.actor as ActorContext,
    profile,
    uiAllowed: true,
    epoch: "generation-read-ui-v1",
    peerCalls: 0,
    authorityCalls: 0,
    unknownCalls: 0,
    identityCalls: 0,
  };
  const identity = new ProductionControlApiIdentity({
    trustedBff: { verify() {} },
    tokens: {
      verify: async ({ accessToken, signal }) => {
        signal.throwIfAborted();
        if (accessToken !== "generation-ui-read-token")
          throw new Error("test_token_invalid");
        state.identityCalls++;
        const now = Date.now();
        return {
          ...state.actor,
          issuer: "https://read-identity.example.test",
          audience: ["read-control"],
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60000).toISOString(),
        };
      },
    },
    expectedIssuer: "https://read-identity.example.test",
    expectedAudience: "read-control",
    timeoutMs: 1000,
    cacheTtlMs: 1000,
  });
  const originalRequestOwner = new InstalledPluginRequestOwner({
    identity,
    profiles: { resolve: async () => state.profile },
    peer: {
      prepare: async () => {
        state.peerCalls++;
        throw new Error("read_must_not_prepare_execution_peer");
      },
    },
  });
  bindInstalledPluginRequestOwner(history.reads, originalRequestOwner, {
    preparation: "configuration",
  });
  const configuration = parseProductionPluginUiConfiguration({
    installRoot: packageSource.installRoot,
    profileAuthority: {
      url: "https://read-authority.example.test/profile",
      serviceToken: "p".repeat(40),
    },
    policyAuthority: {
      url: "https://read-authority.example.test/policy",
      serviceToken: "s".repeat(40),
    },
    publications: [
      {
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    timeoutMs: 1000,
  });
  const fetch: typeof globalThis.fetch = async (url, options) => {
    options?.signal?.throwIfAborted();
    state.authorityCalls++;
    if (String(url).endsWith("/profile")) return Response.json(state.profile);
    if (String(url).endsWith("/policy")) {
      return Response.json(
        state.uiAllowed
          ? { outcome: "allow", authorityEpoch: state.epoch }
          : { outcome: "deny", reasonCode: "test_read_ui_denied" },
      );
    }
    state.unknownCalls++;
    throw new Error("read_has_no_supplier_quote_or_peer_transport");
  };
  const metadataRuntime =
    options.packageDirectory === undefined
      ? undefined
      : createProductionCreativeProjectPluginRuntime({
          projects: {
            service: history.projects,
            pluginUi: { publications: [publication] },
          },
          ui: configuration,
          identity,
          fetch,
        });
  const readRuntime = createProductionProjectGenerationReadPluginRuntime({
    configuration: { publications: [publication] },
    reads: history.service,
    taskReads: history.reads,
    ui: configuration,
    identity,
    fetch,
    ...(metadataRuntime === undefined
      ? {}
      : { hostUiServices: metadataRuntime.hostUiServices }),
  });
  const headers = {
    authorization: "Bearer generation-ui-read-token",
    origin: "https://read-bff.example.test",
  };
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const response = errorResponse(error, request.id);
    return reply.code(response.statusCode).send(response.body);
  });
  let uiRuntime = createProductionPluginUiRuntime(
    {
      configuration,
      ownedProjectGenerationReadActions: readRuntime.owner,
      ...(metadataRuntime === undefined
        ? {}
        : { ownedCreativeProjectActions: metadataRuntime.owner }),
    },
    { ledger, clock: { now: () => new Date().toISOString() }, fetch },
  );
  const ui = createProductionPluginUiRequestService({
    ui: uiRuntime.service,
    projectGenerationReads: readRuntime,
    projects: metadataRuntime,
  });
  registerPluginControlRoutes(app, { identity, pluginUi: ui });
  t.after(async () => {
    await app.close();
    await readRuntime.close();
    await metadataRuntime?.close();
    await uiRuntime.close();
    await originalRequestOwner.close();
  });
  const mount = async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plugins/ui/mounts",
      headers,
      payload: {
        pluginId: source.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: selected.selection.revision,
        expectedPackageDigest: source.packageDigest,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const command = (mountRef: string): InvokePluginUiActionCommand => ({
    mountRef,
    action: "crewon.project-generation-reads.v1.getConceptGeneration",
    input: {
      projectId: history.reference.projectId,
      assetId: history.reference.assetId,
      assetRevision: history.reference.assetRevision,
    },
  });
  const invoke = (mountRef: string, input = command(mountRef)) =>
    app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${mountRef}/actions`,
      headers,
      payload: { action: input.action, input: input.input },
    });
  const invokeDirect = (input: InvokePluginUiActionCommand) =>
    ui.invokeAuthenticatedRequest!(
      requestContext({
        method: "POST",
        url: "/api/v1/plugins/ui/actions",
        headers,
        ip: "127.0.0.1",
      } as never),
      history.actor,
      input,
      new AbortController().signal,
    );
  const decode = (input: InvokePluginUiActionCommand, output: unknown) =>
    parseProjectGenerationReadUiActionResponse(
      {
        action: "crewon.project-generation-reads.v1.getConceptGeneration",
        input: input.input as never,
      },
      output,
    );
  return {
    ...history,
    app,
    state,
    identity,
    source,
    installed,
    ledger,
    publication,
    profile,
    originalRequestOwner,
    readRuntime,
    uiRuntime,
    ui,
    mount,
    command,
    invoke,
    invokeDirect,
    decode,
    configuration,
    installationConfiguration: {
      ...packageSource.configuration([source]),
      profileAuthority: configuration.profileAuthority,
      policyAuthority: configuration.policyAuthority,
    },
    fetch,
    selected,
    schema: backend === "postgres" ? history.prefix.slice(1, -2) : undefined,
    request: {
      method: "POST",
      url: "/api/v1/plugins/ui/actions",
      remoteAddress: "127.0.0.1",
      headers,
    },
    nextKey: () => randomUUID(),
  };
}
