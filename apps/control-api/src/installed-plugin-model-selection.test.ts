import test from "node:test";
import assert from "node:assert/strict";
import {
  createInstalledPluginModelSelection,
  parseInstalledPluginModelBindings,
} from "./installed-plugin-model-selection.ts";
import {
  peerFixture,
  actor,
  digester,
} from "../../runtime-worker/src/installed-plugin-peer.test-support.ts";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";

test("remote model selection resolves immutable installed model siblings and fails closed on changed deployment or owner", async (t) => {
  // Actual installed SDK release, immutable SQL asset and deployment. No model completion is inferred.
  const f = await peerFixture(t, "sqlite", 1, { modelSiblings: true }),
    entry = f.entries[0]!,
    identity = f.identity();
  const selected = await f.store
    .pluginInstallationStore()
    .loadSelection({ scope: f.scope, pluginId: identity.pluginId });
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    ...f.scope,
    pluginId: identity.pluginId,
    publisherId: identity.publisherId,
    version: identity.version,
    packageDigest: identity.packageDigest,
    selectionRevision: selected!.revision,
    contributionId: "workbench",
    action: "project.execute",
    authorityEpoch: "test-current-policy",
  });
  const bindings = parseInstalledPluginModelBindings(
    f.entries
      .slice(0, 2)
      .map((e, i) => ({
        scope: f.scope,
        pluginId: identity.pluginId,
        publisherId: identity.publisherId,
        version: identity.version,
        packageDigest: identity.packageDigest,
        configurationDigest: entry.configuration.contentDigest,
        modelId: i === 0 ? "fixture-existing-model" : "fixture-alternate-model",
        target: e.target,
      })),
  );
  let active = true;
  const controller = new AbortController();
  const owner = {
    bindings,
    store: f.store,
    digester,
    currentSignal: () => controller.signal,
    assertCurrent: async () => {
      if (!active) throw new Error("owner_withdrawn");
    },
  };
  const port = createInstalledPluginModelSelection(owner),
    input = {
      actor,
      pin,
      configuration: entry.configuration,
      modelId: "fixture-alternate-model",
    };
  const prepared = await port.prepareModel(input);
  assert.equal(prepared.modelId, input.modelId);
  assert.deepEqual(prepared.target, f.entries[1]!.target);
  await prepared.assertCurrent();
  const { modelId: _, ...original } = input;
  assert.deepEqual(
    (await port.prepareTarget!({ ...original, target: prepared.target }))
      .target,
    prepared.target,
  );
  for (const change of [
    { modelId: "missing-model" },
    { actor: { ...actor, tenantId: "foreign" } },
    {
      pin: {
        ...pin,
        authorityEpoch: pin.authorityEpoch,
        packageDigest: `sha256:${"f".repeat(64)}`,
      },
    },
  ])
    await assert.rejects(port.prepareModel({ ...input, ...change }));
  assert.throws(() =>
    parseInstalledPluginModelBindings([...bindings, bindings[0]]),
  );
  const bad = createInstalledPluginModelSelection({
    ...owner,
    store: {
      loadAgentVersion: (q) => f.store.loadAgentVersion(q),
      loadAgentVersionDeployment: async (q) => ({
        ...(await f.store.loadAgentVersionDeployment(q))!,
        tenantId: "foreign",
      }),
    },
  });
  await assert.rejects(bad.prepareModel(input), /selection_unavailable/);
  active = false;
  await assert.rejects(prepared.assertCurrent(), /owner_withdrawn/);
  active = true;
  controller.abort();
  assert.throws(prepared.assertActive);
  await assert.rejects(port.prepareModel(input));
});
