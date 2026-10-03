import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import {
  configuration,
  receipt,
  scope,
} from "./extension-store.test-support.ts";
import { agentVersionAsset } from "./agent-version-store-conformance.test-support.ts";
import {
  releaseActivation,
  releaseBundle,
} from "./agent-version-release-store-conformance.test-support.ts";

test("Native synchronous configuration snapshot shares actual parent writes and rejects parent close", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "crewon-candidate-config-snapshot-"),
  );
  const parent = new SqliteRunStore(join(root, "control.sqlite"));
  t.after(async () => {
    await parent.close();
    await rm(root, { recursive: true, force: true });
  });
  const original = parent.extensionStore(),
    sibling = parent.extensionStore();
  await original.migrate();
  assert.equal(sibling.currentLatestExtensionConfiguration(scope), null);
  const first = configuration();
  await original.saveExtensionConfiguration({
    configuration: first,
    expectedRevision: 0,
    receipt: receipt("first-native-snapshot"),
  });
  assert.deepEqual(sibling.currentLatestExtensionConfiguration(scope), first);
  const second = configuration({
    revision: 2,
    parameters: { serviceUrl: "https://changed-native-snapshot.example/" },
  });
  await original.saveExtensionConfiguration({
    configuration: second,
    expectedRevision: 1,
    receipt: receipt("second-native-snapshot"),
  });
  assert.deepEqual(sibling.currentLatestExtensionConfiguration(scope), second);
  assert.deepEqual(
    await sibling.loadLatestExtensionConfiguration(scope),
    second,
  );
  await parent.close();
  assert.throws(
    () => sibling.currentLatestExtensionConfiguration(scope),
    /closed/u,
  );
});

test("Native synchronous Agent and deployment snapshots share actual release changes and parent lifetime", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "crewon-candidate-target-snapshot-"),
  );
  const parent = new SqliteRunStore(join(root, "control.sqlite"));
  t.after(async () => {
    await parent.close();
    await rm(root, { recursive: true, force: true });
  });
  const asset = agentVersionAsset("tenant-1", "agent-1");
  const locator = {
    tenantId: asset.tenantId,
    agentVersionId: asset.agentVersionId,
  };
  assert.equal(parent.currentAgentVersion(locator), null);
  assert.equal(parent.currentAgentVersionDeployment(locator), null);
  await parent.registerAgentVersion(asset);
  assert.deepEqual(parent.currentAgentVersion(locator), asset);
  const first = releaseBundle("e", [asset.agentVersionId]);
  const firstActivation = releaseActivation(
    first,
    "first-snapshot-release",
    null,
  );
  await parent.activateAgentVersionRelease({
    bundle: first,
    activation: firstActivation,
    expectedActiveReleaseId: null,
  });
  assert.deepEqual(parent.currentAgentVersionDeployment(locator), {
    ...first.deployments[0],
    deployedAt: firstActivation.activatedAt,
  });
  const nextAsset = agentVersionAsset("tenant-1", "agent-2");
  await parent.registerAgentVersion(nextAsset);
  const second = releaseBundle("f", [nextAsset.agentVersionId]);
  const nextLocator = {
    tenantId: nextAsset.tenantId,
    agentVersionId: nextAsset.agentVersionId,
  };
  const secondActivation = releaseActivation(
    second,
    "second-snapshot-release",
    first.releaseId,
  );
  await parent.activateAgentVersionRelease({
    bundle: second,
    activation: secondActivation,
    expectedActiveReleaseId: first.releaseId,
  });
  assert.deepEqual(parent.currentAgentVersionDeployment(nextLocator), {
    ...second.deployments[0],
    deployedAt: secondActivation.activatedAt,
  });
  assert.deepEqual(
    await parent.loadAgentVersionDeployment(nextLocator),
    parent.currentAgentVersionDeployment(nextLocator),
  );
  assert.deepEqual(parent.currentAgentVersionDeployment(locator), {
    ...first.deployments[0],
    deployedAt: firstActivation.activatedAt,
  });
  await parent.close();
  assert.throws(() => parent.currentAgentVersion(locator), /closed/u);
  assert.throws(() => parent.currentAgentVersionDeployment(locator), /closed/u);
});
