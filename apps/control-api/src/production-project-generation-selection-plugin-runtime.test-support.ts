import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import {
  ProjectConceptSelectionApplicationService,
  type ActorContext,
} from "@crewon/application";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { conceptSelectionHttpFixture } from "./project-generation-selection-route.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import {
  InstalledPluginRequestOwner,
  bindInstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { createProductionProjectGenerationSelectionPluginRuntime } from "./production-project-generation-selection-plugin-runtime.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { registerProjectGenerationSelectionRoutes } from "./project-generation-selection-route.ts";
import { errorResponse } from "./control-api-errors.ts";

/** Actual installed source bytes, original current HTTP identity/profile and same SQL saved paid history.
 * Token, policy and funded history are explicit fixtures; no live supplier, human wallet or Worker is claimed. */
export async function productionConceptSelectionUiFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const history = await conceptSelectionHttpFixture(t, backend);
  const files = await productionSourceFixture(t);
  const source = await files.source("selection-ui", {
    pluginId: "test.exact-selection",
    uiOnly: true,
    requiredService: "crewon.project-generation-selections",
  });
  const installed = await installLocalPluginPackage({
    directory: source.directory,
    installRoot: files.installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const profile = {
    tenantId: history.actor.tenantId,
    spaceId: history.actor.spaceId,
    profileId: history.enabled.selection.profileId,
  };
  const ledger = history.first.parent.pluginInstallationStore();
  const record = await ledger.recordInstalledPackage(
    installationRecipe("physical-selection-package", {
      scope: profile,
      actor: history.actor,
      pluginId: installed.descriptor.pluginId,
      publisherId: installed.descriptor.publisherId,
      version: installed.descriptor.version,
      packageDigest: installed.packageDigest,
    }),
  );
  const selected = await ledger.commitSelection(
    selectionRecipe(record.selection, "physical-selection-enabled", {
      actor: history.actor,
    }),
  );
  const state = {
    actor: history.actor as ActorContext,
    profile,
    allowed: true,
    epoch: "selection-ui-current",
    peerCalls: 0,
    unknownCalls: 0,
    afterCommit: null as (() => void) | null,
  };
  const identity = new ProductionControlApiIdentity({
    trustedBff: { verify() {} },
    tokens: {
      verify: async ({ accessToken, signal }) => {
        signal.throwIfAborted();
        if (accessToken !== "selection-fixture-token")
          throw new Error("fixture_invalid_token");
        const now = Date.now();
        return {
          ...state.actor,
          issuer: "https://selection-identity.test",
          audience: ["selection-control"],
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60000).toISOString(),
        };
      },
    },
    expectedIssuer: "https://selection-identity.test",
    expectedAudience: "selection-control",
    timeoutMs: 1000,
    cacheTtlMs: 1000,
  });
  const originalRequests = new InstalledPluginRequestOwner({
    identity,
    profiles: { resolve: async () => state.profile },
    peer: {
      prepare: async () => {
        state.peerCalls++;
        throw new Error("selection_must_not_prepare_node");
      },
    },
  });
  bindInstalledPluginRequestOwner(history.reads, originalRequests, {
    preparation: "configuration",
  });
  const configuration = parseProductionPluginUiConfiguration({
    installRoot: files.installRoot,
    profileAuthority: {
      url: "https://selection-authority.test/profile",
      serviceToken: "p".repeat(40),
    },
    policyAuthority: {
      url: "https://selection-authority.test/policy",
      serviceToken: "s".repeat(40),
    },
    publications: [
      {
        pluginId: installed.descriptor.pluginId,
        publisherId: installed.descriptor.publisherId,
        packageDigest: installed.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    timeoutMs: 1000,
  });
  const fetch: typeof globalThis.fetch = async (url, options) => {
    options?.signal?.throwIfAborted();
    if (String(url).endsWith("/profile")) return Response.json(state.profile);
    if (String(url).endsWith("/policy"))
      return Response.json(
        state.allowed
          ? { outcome: "allow", authorityEpoch: state.epoch }
          : { outcome: "deny", reasonCode: "selection-source-denied" },
      );
    state.unknownCalls++;
    throw new Error("selection_has_no_provider_quote_or_peer_transport");
  };
  const originalSelect =
    ProjectConceptSelectionApplicationService.prototype.selectConceptImage;
  t.mock.method(
    ProjectConceptSelectionApplicationService.prototype,
    "selectConceptImage",
    async function (
      this: ProjectConceptSelectionApplicationService,
      ...args: Parameters<typeof originalSelect>
    ) {
      const value = await Reflect.apply(originalSelect, this, args);
      if (this === history.selectionService) state.afterCommit?.();
      return value;
    },
  );
  const selectionRuntime =
    createProductionProjectGenerationSelectionPluginRuntime({
      configuration: {
        publications: [
          {
            pluginId: installed.descriptor.pluginId,
            packageDigest: installed.packageDigest,
            contributionId: "workbench",
          },
        ],
      },
      selections: history.selectionService,
      taskReads: history.reads,
      ui: configuration,
      identity,
      fetch,
    });
  const uiRuntime = createProductionPluginUiRuntime(
    { configuration, ownedProjectSelectionActions: selectionRuntime.owner },
    { ledger, clock: { now: () => new Date().toISOString() }, fetch },
  );
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const value = errorResponse(error, request.id);
    return reply.code(value.statusCode).send(value.body);
  });
  const ui = createProductionPluginUiRequestService({
    ui: uiRuntime.service,
    projectSelections: selectionRuntime,
  });
  registerPluginControlRoutes(app, { identity, pluginUi: ui });
  registerProjectGenerationSelectionRoutes(app, {
    identity,
    selections: history.selectionService,
    extensionReads: history.reads,
  });
  t.after(async () => {
    await app.close();
    await uiRuntime.close();
    await selectionRuntime.close();
    await originalRequests.close();
  });
  const headers = {
    authorization: "Bearer selection-fixture-token",
    origin: "https://selection-bff.test",
  };
  const mount = async () => {
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/plugins/ui/mounts",
      headers,
      payload: {
        pluginId: installed.descriptor.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: selected.selection.revision,
        expectedPackageDigest: installed.packageDigest,
      },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().mountRef as string;
  };
  const invoke = (
    mountRef: string,
    input = {
      ...history.selectionBody(),
      idempotencyKey: "physical-selected-image",
    },
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${mountRef}/actions`,
      headers,
      payload: {
        action: "crewon.project-generation-selections.v1.selectConceptImage",
        input,
      },
    });
  return {
    ...history,
    app,
    headers,
    mount,
    invoke,
    state,
    installed,
    ledger,
    selected,
    selectionRuntime,
    uiRuntime,
    originalRequests,
  };
}
