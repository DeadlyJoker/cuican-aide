import test from "node:test";
import assert from "node:assert/strict";
import { prepareDesktopNativePluginModel } from "./desktop-native-plugin-model-selection.ts";
import type { DesktopNativePluginTaskBinding } from "./desktop-native-plugin-task-authority.ts";
import {
  peerFixture,
  actor,
} from "../../runtime-worker/src/installed-plugin-peer.test-support.ts";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";

/** Actual installed SDK release and immutable Store data; request ownership is named, no model/supplier execution. */
async function fixture(t: Parameters<typeof peerFixture>[0]) {
  const f = await peerFixture(t, "sqlite", 1, { modelSiblings: true });
  const original = f.entries[0]!,
    identity = f.identity();
  const selection = await f.store
    .pluginInstallationStore()
    .loadSelection({ scope: f.scope, pluginId: identity.pluginId });
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    ...f.scope,
    pluginId: identity.pluginId,
    publisherId: identity.publisherId,
    version: identity.version,
    packageDigest: identity.packageDigest,
    selectionRevision: selection!.revision,
    contributionId: "workbench",
    action: "project.execute",
    authorityEpoch: "named-model-owner",
  });
  const publication = f.entries.map((entry) => ({
    identity: entry.packageIdentity,
    configuration: entry.configuration,
    target: entry.target,
  }));
  const binding = {
    store: f.store,
    configuration: {
      scope: f.scope,
      authorityEpoch: pin.authorityEpoch,
      publications: [
        { pluginId: identity.pluginId, packageDigest: identity.packageDigest },
      ],
    },
    nativeControl: {
      authority: { packages: [identity] },
      publication: { entries: publication },
    },
  } as unknown as DesktopNativePluginTaskBinding;
  const state = { active: true, checks: 0 };
  const active = () => {
    state.checks++;
    if (!state.active) throw new Error("named_request_owner_withdrawn");
  };
  const context = {
    binding,
    input: {
      actor,
      pin,
      configuration: original.configuration,
      modelId: "fixture-alternate-model",
    },
    async assertRequestCurrent() {
      active();
    },
    assertCommitCurrent: active,
  };
  return { ...f, context, state, publication };
}
test("Native model selection resolves the exact Main-published sibling from actual immutable assets and deployments", async (t) => {
  const f = await fixture(t);
  const selected = await prepareDesktopNativePluginModel(f.context);
  assert.deepEqual(selected.target, f.entries[1]!.target);
  assert.equal(selected.modelId, "fixture-alternate-model");
  await selected.assertCurrent();
  selected.assertActive();
  f.state.active = false;
  assert.throws(() => selected.assertActive(), /owner_withdrawn/);
});
test("unpublished, duplicate, forged deployment and withdrawn installation cannot select a new model", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareDesktopNativePluginModel({
      ...f.context,
      input: { ...f.context.input, modelId: "unpublished-model" },
    }),
    /model_selection_unavailable/,
  );
  // Two Main entries sharing a model cannot be guessed or silently substituted.
  await assert.rejects(
    prepareDesktopNativePluginModel({
      ...f.context,
      input: { ...f.context.input, modelId: "fixture-existing-model" },
    }),
    /model_selection_unavailable/,
  );
  const original = f.publication[1]!.target;
  f.publication[1] = {
    ...f.publication[1]!,
    target: { ...original, materializationDigest: `sha256:${"f".repeat(64)}` },
  };
  await assert.rejects(
    prepareDesktopNativePluginModel(f.context),
    /model_selection_invalid/,
  );
  f.publication[1] = { ...f.publication[1]!, target: original };
  await f.select("disabled");
  await assert.rejects(
    prepareDesktopNativePluginModel(f.context),
    /model_selection_invalid/,
  );
});
