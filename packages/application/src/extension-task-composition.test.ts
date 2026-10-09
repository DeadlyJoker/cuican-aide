import assert from "node:assert/strict";
import test from "node:test";
import { createPluginCompositionLock } from "@crewon/contracts/plugins";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

function lock(revision = 1, patch: Partial<typeof taskPin> = {}) {
  const pin = { ...taskPin, ...patch };
  return createPluginCompositionLock(
    {
      schemaVersion: "crewon.plugin-composition-lock.v1",
      scope: {
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        profileId: pin.profileId,
        authorityEpoch: pin.authorityEpoch,
      },
      revision,
      nodes: [
        {
          pluginId: pin.pluginId,
          publisherId: pin.publisherId,
          version: pin.version,
          packageDigest: pin.packageDigest,
          selectionRevision: pin.selectionRevision,
          hostApi: "crewon.plugin-host.v1",
          requires: [],
          provides: [],
        },
      ],
      hostServices: [],
    },
    taskDigester,
  );
}

test("new composed plugin task captures the verified head while receipt replay never reads a later head", async () => {
  const f = pluginTaskFixture();
  let reads = 0;
  const original = lock();
  const service = f.create({
    extensions: {
      ...f.extensions,
      compositionBindingVersion: "crewon.extension-run-binding.v1",
    },
    pluginCompositions: {
      loadCurrent: async (input) => {
        reads++;
        assert.deepEqual(input.scope, {
          tenantId: taskPin.tenantId,
          spaceId: taskPin.spaceId,
          profileId: taskPin.profileId,
        });
        return original;
      },
    },
  });
  const first = await service.createTaskFromPlugin(
    taskActor,
    taskCommand,
    taskPin,
  );
  assert.equal(first.binding.schemaVersion, "crewon.extension-run-binding.v1");
  if (first.binding.schemaVersion !== "crewon.extension-run-binding.v1")
    assert.fail();
  assert.equal(first.binding.composition.lockDigest, original.lockDigest);
  const restarted = f.create({
    pluginCompositions: {
      loadCurrent: async () => {
        throw new Error("must not read current head on replay");
      },
    },
  });
  const replay = await restarted.createTaskFromPlugin(
    taskActor,
    taskCommand,
    taskPin,
  );
  assert.deepEqual(replay.binding, first.binding);
  assert.equal(reads, 1);
  assert.equal(f.state.commits.length, 1);
  assert.equal(f.state.quoteCalls, 1);
});

test("explicit composition issuer refuses missing, foreign, stale-root or altered head without committing", async () => {
  for (const item of [
    { value: null, error: /composition_missing/ },
    {
      value: lock(1, { profileId: "foreign-profile" }),
      error: /composition_scope_mismatch/,
    },
    {
      value: lock(1, { authorityEpoch: "foreign-epoch" }),
      error: /composition_epoch_mismatch/,
    },
    {
      value: lock(1, { packageDigest: taskDigester.sha256("new-package") }),
      error: /composition_root_mismatch/,
    },
    { value: { ...lock(), revision: 2 }, error: /composition_invalid/ },
  ]) {
    const f = pluginTaskFixture();
    const service = f.create({
      extensions: {
        ...f.extensions,
        compositionBindingVersion: "crewon.extension-run-binding.v1",
      },
      pluginCompositions: {
        loadCurrent: async () => item.value as ReturnType<typeof lock>,
      },
    });
    await assert.rejects(
      service.createTaskFromPlugin(taskActor, taskCommand, taskPin),
      item.error,
    );
    assert.equal(f.state.commits.length, 0);
    assert.equal(f.state.ids, 0);
  }
});

test("issuer cannot silently downgrade an unsupported Store to a single-package task", async () => {
  const f = pluginTaskFixture();
  let reads = 0;
  const service = f.create({
    pluginCompositions: {
      loadCurrent: async () => {
        reads++;
        return lock();
      },
    },
  });
  await assert.rejects(
    service.createTaskFromPlugin(taskActor, taskCommand, taskPin),
    /composition_port_unavailable/,
  );
  assert.equal(reads, 0);
  assert.equal(f.state.commits.length, 0);
});
