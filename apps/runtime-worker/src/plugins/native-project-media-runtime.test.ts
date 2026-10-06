import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { nativeMediaFixture } from "./native-project-media-runtime.test-support.ts";
import { createInstalledPluginWorkerAuthority } from "./installed-plugin-worker-authority.ts";
import {
  desktopProjectMaterialStorageFromEnvironment,
  loadDesktopProjectMaterialArchive,
} from "@crewon/media-runtime/desktop-project-material-archive";

test("actual Native startup awaits both installed graphs and prepares real media on the original parent", async (t) => {
  const f = await nativeMediaFixture(t);
  assert.throws(
    () => createInstalledPluginWorkerAuthority(f.config),
    /async_preparation_required/,
  );
  const worker = await f.open();
  const media = worker.installedPluginExecution.projectMedia;
  assert.ok(media);
  assert.deepEqual(
    media.reviews.map((r) => r.workflow.workflowId),
    ["krea2-reference-four-view", "flux2-three-reference-storyboard"],
  );
  assert.equal(media.reviews[0]!.promptBinding.nodeId, "143");
  assert.equal(media.reviews[1]!.imageBindings.length, 3);
  assert.ok(Object.isFrozen(media.reviews[0]!.template));
  const prepared = await f.prepare(worker);
  const archive = loadDesktopProjectMaterialArchive(
    desktopProjectMaterialStorageFromEnvironment(f.environment),
    f.f.scope,
  );
  try {
    assert.deepEqual(readdirSync(archive.rootDirectory), []);
  } finally {
    archive.encryptionKey.fill(0);
  }
  await prepared.close();
  await worker.close();
  const reopened = await f.open();
  await f.prepare(reopened);
  // Closing the media runtime never closes or replaces the original borrowed parent.
  assert.ok(
    await f.f.store
      .extensionStore()
      .loadExtensionConfiguration({
        ...f.f.scope,
        pluginId: f.f.identity.pluginId,
        revision: 1,
      }),
  );
});

test("old Native metadata keeps its original synchronous and async path without requiring archive credentials", async (t) => {
  const f = await nativeMediaFixture(t, { generation: false });
  const worker = await f.open({});
  assert.equal(worker.installedPluginExecution.projectMedia, undefined);
  assert.ok(worker.installedPluginExecution.projectMediaInputs);
  const old = createInstalledPluginWorkerAuthority(f.config);
  try {
    assert.equal(old.installedPluginExecution.projectMedia, undefined);
  } finally {
    await old.close();
  }
});

for (const reviewMismatch of ["graph", "manifest"] as const)
  test(`Native rejects ${reviewMismatch} review drift before creating a media runtime`, async (t) => {
    const f = await nativeMediaFixture(t, { reviewMismatch });
    await assert.rejects(f.open());
  });

test("generation needs host archive configuration and file/actor revocation fences remain live", async (t) => {
  const f = await nativeMediaFixture(t);
  await assert.rejects(f.open({}), /storage_required/);
  const worker = await f.open();
  const media = worker.installedPluginExecution.projectMedia!;
  const p = {
    actor: f.manifest.actor,
    action: "projectMediaRun:submit" as const,
    resource: {
      runId: "named-run",
      projectId: "named-project",
      mediaInputId: "named-input",
      inputRevision: 1,
      executionId: "named-execution",
    },
  };
  assert.deepEqual(await media.authorization.authorize(p), {
    outcome: "allow",
  });
  await assert.rejects(
    media.authorization.authorize({
      ...p,
      actor: { ...p.actor, principalId: "foreign" },
    }),
  );
  const old = readFileSync(f.f.policyPath);
  writeFileSync(f.f.policyPath, old);
  await assert.rejects(media.authorization.authorize(p));
  await worker.close();
  assert.throws(() => media.authorization.assertActive(p));
});

test("Control and Worker derive stable private archive keys, separated from artifact keys and other profiles", async (t) => {
  const f = await nativeMediaFixture(t);
  const storage = desktopProjectMaterialStorageFromEnvironment(f.environment);
  const a = loadDesktopProjectMaterialArchive(storage, f.f.scope);
  const b = loadDesktopProjectMaterialArchive(storage, f.f.scope);
  const other = loadDesktopProjectMaterialArchive(storage, {
    ...f.f.scope,
    profileId: "other-profile",
  });
  try {
    assert.deepEqual(a, b);
    assert.notDeepEqual(
      a.encryptionKey,
      new Uint8Array(
        readFileSync(f.environment.CREWON_ARTIFACT_ENCRYPTION_KEY_PATH),
      ),
    );
    assert.notDeepEqual(a.encryptionKey, other.encryptionKey);
    assert.notEqual(a.archiveId, other.archiveId);
    assert.notEqual(a.rootDirectory, other.rootDirectory);
  } finally {
    for (const x of [a, b, other]) x.encryptionKey.fill(0);
  }
});
