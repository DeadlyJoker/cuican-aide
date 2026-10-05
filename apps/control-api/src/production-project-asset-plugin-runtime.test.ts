import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { InvokePluginUiActionCommand } from "@crewon/application";
import { PluginProjectAssetRecoveryApplicationService } from "@crewon/application";
import { projectAssetFixture } from "../../../packages/store/src/project-asset.test-support.ts";
import { captureProductionPluginUiActions } from "./production-plugin-ui-composition.ts";
import { captureProductionPluginUiOwnerConfiguration } from "./project-query-plugin-composition.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import {
  createProductionProjectAssetPluginRuntime,
  productionProjectAssetOwnerConfiguration,
  captureProductionProjectAssetOwnerCleanup,
} from "./production-project-asset-plugin-runtime.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import {
  actor,
  scope,
  request,
  identityFixture,
  deferred,
  digester,
} from "./installed-plugin-task.test-support.ts";
import { InstalledPluginPeerClient } from "./installed-plugin-peer-client.ts";
async function fixture(t: TestContext) {
  const f = await projectAssetFixture(t, "sqlite"),
    identity = identityFixture();
  const publication = {
      pluginId: f.installation.pluginId,
      packageDigest: f.installation.packageDigest,
      contributionId: "workbench",
    },
    grant = { publications: [publication] };
  const recovery = new PluginProjectAssetRecoveryApplicationService({
    journal: f.journal,
    projects: f.parent.creativeProjectStore(),
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    publications: grant.publications,
    clock: { now: () => "2026-10-06T08:00:00.000Z" },
    digester,
  });
  const projects: PreparedCreativeProjects = {
    service: f.projects,
    assetService: f.assets,
    assetStore: f.assetStore,
    assetUi: grant,
    assetRecovery: grant,
    assetRecoveryService: recovery,
  };
  const ui = parseProductionPluginUiConfiguration({
    installRoot: "/fixture-assets",
    profileAuthority: {
      url: "https://fixture-assets.example/profile",
      serviceToken: "profile-" + "p".repeat(32),
    },
    policyAuthority: {
      url: "https://fixture-assets.example/policy",
      serviceToken: "policy-" + "p".repeat(32),
    },
    publications: [
      {
        pluginId: publication.pluginId,
        publisherId: f.installation.publisherId,
        packageDigest: publication.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    timeoutMs: 1000,
  });
  let reads = 0;
  const input = {
    projects,
    ui,
    identity: identity.identity,
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(String(input), ui.profileAuthority.url);
      assert.equal(init?.signal?.aborted, false);
      reads++;
      return Response.json(scope);
    },
  };
  const runtime = createProductionProjectAssetPluginRuntime(input);
  assert.ok(runtime);
  t.after(() => runtime.close());
  return {
    ...f,
    ...identity,
    input,
    projects,
    ui,
    runtime,
    reads: () => reads,
  };
}
const read: InvokePluginUiActionCommand = {
  mountRef: "m".repeat(40),
  action: "crewon.project-assets.v1.listAssets",
  input: { projectId: "project", afterAssetId: null, limit: 16 },
};
function uiService(
  invoke: PluginUiControlService["invoke"],
): PluginUiControlService {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    catalog: unused,
    openMount: unused,
    validateMount: unused,
    renewMount: unused,
    readAsset: unused,
    closeMount: unused,
    invoke,
  };
}

test("production assets require independent service/publication/recovery, never borrowed old text grant", async (t) => {
  const f = await fixture(t);
  assert.equal(
    createProductionProjectAssetPluginRuntime({
      ...f.input,
      projects: { service: f.input.projects.service },
    }),
    undefined,
  );
  for (const projects of [
    { ...f.projects, assetService: undefined },
    { ...f.projects, assetRecoveryService: undefined },
    {
      ...f.projects,
      assetUi: {
        publications: [
          {
            ...f.projects.assetUi!.publications[0]!,
            packageDigest: digester.sha256("foreign"),
          },
        ],
      },
    },
  ])
    assert.throws(() =>
      createProductionProjectAssetPluginRuntime({ ...f.input, projects }),
    );
  assert.throws(
    () =>
      captureProductionPluginUiActions({
        configuration: f.ui,
        ownedProjectAssetActions: { ...f.runtime.owner } as never,
      }),
    /asset_owner_invalid/,
  );
  assert.throws(
    () =>
      captureProductionPluginUiActions({
        configuration: f.ui,
        ownedProjectAssetRecoveryActions: f.runtime.owner as never,
      }),
    /asset_recovery_owner_invalid/,
  );
  const owners = productionProjectAssetOwnerConfiguration(f.runtime),
    captured = captureProductionPluginUiOwnerConfiguration({
      configuration: f.ui,
      ...owners,
    });
  assert.equal(captured.ownedProjectAssetActions, f.runtime.owner);
  assert.equal(
    captured.ownedProjectAssetRecoveryActions,
    f.runtime.recoveryOwner,
  );
});
test("asset and recovery HTTP scopes use current real identity/profile without preparing Node", async (t) => {
  const f = await fixture(t);
  let peers = 0;
  t.mock.method(InstalledPluginPeerClient.prototype, "prepare", async () => {
    peers++;
    throw new Error("unexpected_peer");
  });
  let invocations = 0;
  const service = createProductionPluginUiRequestService({
    ui: uiService(async () => {
      invocations++;
      return { fixture: "authenticated read only" };
    }),
    assets: f.runtime,
  });
  assert.deepEqual(
    await service.invokeAuthenticatedRequest!(
      request,
      actor,
      read,
      new AbortController().signal,
    ),
    { fixture: "authenticated read only" },
  );
  await service.invokeAuthenticatedRequest!(
    request,
    actor,
    {
      ...read,
      action: "crewon.project-asset-recovery.v1.getPending",
      input: {},
    },
    new AbortController().signal,
  );
  assert.ok(f.reads() > 0);
  assert.equal(invocations, 2);
  assert.equal(peers, 0);
  f.setActor({ ...actor, principalId: "foreign" });
  await assert.rejects(
    service.invokeAuthenticatedRequest!(
      request,
      actor,
      read,
      new AbortController().signal,
    ),
  );
  assert.equal(invocations, 2);
});
test("unsupported asset namespace never falls through to generic actions or absent recovery", async (t) => {
  const f = await fixture(t);
  let invoked = 0;
  assert.throws(() =>
    f.runtime.invokeAuthenticatedRequest(
      request,
      actor,
      { ...read, action: "crewon.project-assets.v99.unknown" },
      undefined,
      async () => {
        invoked++;
        return null;
      },
    ),
  );
  const withoutRecovery = createProductionProjectAssetPluginRuntime({
    ...f.input,
    projects: {
      ...f.projects,
      assetRecovery: undefined,
      assetRecoveryService: undefined,
    },
  });
  assert.ok(withoutRecovery);
  t.after(() => withoutRecovery.close());
  assert.throws(() =>
    withoutRecovery.invokeAuthenticatedRequest(
      request,
      actor,
      {
        ...read,
        action: "crewon.project-asset-recovery.v1.getPending",
        input: {},
      },
      undefined,
      async () => {
        invoked++;
        return null;
      },
    ),
  );
  assert.equal(invoked, 0);
});
test("close withdraws immediately and joins actual pending request; late read does not publish", async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred();
  const operation = f.runtime.invokeAuthenticatedRequest(
    request,
    actor,
    read,
    undefined,
    async () => {
      entered.resolve();
      await release.promise;
      return { late: true };
    },
  );
  await entered.promise;
  let closed = false;
  const closing = f.runtime.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.throws(() => f.runtime.owner.assertAvailable());
  release.resolve();
  await assert.rejects(operation);
  await closing;
  assert.equal(closed, true);
  assert.equal(f.runtime.close(), f.runtime.close());
});
test("transferred genuine owners are both withdrawn and joined by startup cleanup", async (t) => {
  const f = await fixture(t),
    cleanup = captureProductionProjectAssetOwnerCleanup(
      productionProjectAssetOwnerConfiguration(f.runtime),
    );
  await cleanup();
  assert.throws(() => f.runtime.owner.assertAvailable());
  assert.throws(() => f.runtime.recoveryOwner!.assertAvailable());
});

test("dedicated asset owner accessors are rejected without execution and cannot be substituted by stage/old namespaces", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const input: Parameters<typeof captureProductionPluginUiActions>[0] = {
    configuration: f.ui,
  };
  Object.defineProperty(input, "ownedProjectAssetActions", {
    enumerable: true,
    get() {
      calls++;
      return f.runtime.owner;
    },
  });
  const cleanup = captureProductionProjectAssetOwnerCleanup(input);
  await cleanup();
  assert.throws(
    () => captureProductionPluginUiActions(input),
    /asset_owner_invalid/,
  );
  assert.equal(calls, 0);
  f.runtime.owner.assertAvailable();
  assert.throws(
    () =>
      captureProductionPluginUiActions({
        configuration: f.ui,
        ownedProjectAssetStageActions: f.runtime.owner as never,
      }),
    /asset_stage_owner_invalid/,
  );
});
