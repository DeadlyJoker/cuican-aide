import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import type { RunState } from "@crewon/domain";
import { ModelImageArtifactSink } from "./model-image-artifact-sink.ts";

const input = {
  runId: "run-1",
  segmentId: "segment-1",
  itemId: "image-1",
  mimeType: "image/png" as const,
  bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 255]),
};
const run = {
  tenantId: "tenant-1",
  runId: "run-1",
  spaceId: "space-1",
  createdByActorId: "actor-1",
  status: "running",
  cancelRequested: false,
} as RunState;

test("image persistence reuses one artifact across resumed segments without accepting changed output", async () => {
  const artifacts = new InMemoryArtifactStore();
  const sink = new ModelImageArtifactSink({
    artifacts,
    tenantId: "tenant-1",
    keyId: "key-1",
  });
  sink.bindRunStore({ loadRun: async () => run });
  const signal = new AbortController().signal;
  const first = await sink.persist(input, signal);
  assert.deepEqual(
    await sink.persist({ ...input, segmentId: "segment-2" }, signal),
    first,
  );
  const record = await artifacts.get({
    tenantId: "tenant-1",
    artifactId: first.artifactRef,
  });
  assert.deepEqual(record?.source, {
    kind: "modelImage",
    runId: "run-1",
    segmentId: "segment-1",
    itemId: "image-1",
  });
  await assert.rejects(
    sink.persist(
      { ...input, bytes: new Uint8Array([...input.bytes, 1]) },
      signal,
    ),
    /model_image_replay_conflict/,
  );
  assert.equal(record?.ownerActorId, "actor-1");
  assert.equal(record?.spaceId, "space-1");
});

test("image persistence requires live trusted Run ownership and honors cancellation", async () => {
  for (const state of [
    null,
    { ...run, tenantId: "other" },
    { ...run, runId: "other" },
    { ...run, status: "completed" },
    { ...run, cancelRequested: true },
  ]) {
    const artifacts = new InMemoryArtifactStore();
    const sink = new ModelImageArtifactSink({
      artifacts,
      tenantId: "tenant-1",
      keyId: "key-1",
    });
    sink.bindRunStore({ loadRun: async () => state as RunState | null });
    await assert.rejects(
      sink.persist(input, new AbortController().signal),
      /model_image_run_authority_invalid/,
    );
  }
  const sink = new ModelImageArtifactSink({
    artifacts: new InMemoryArtifactStore(),
    tenantId: "tenant-1",
    keyId: "key-1",
  });
  await assert.rejects(
    sink.persist(input, new AbortController().signal),
    /model_image_authority_unavailable/,
  );
  sink.bindRunStore({ loadRun: async () => run });
  await assert.rejects(sink.persist(input, AbortSignal.abort()), /abort/i);
  await assert.rejects(
    sink.persist(
      { ...input, bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
      new AbortController().signal,
    ),
    /too_large/,
  );
  assert.throws(
    () => sink.bindRunStore({ loadRun: async () => run }),
    /already_bound/,
  );
});
