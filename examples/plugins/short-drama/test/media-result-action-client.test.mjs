import assert from "node:assert/strict";
import test from "node:test";
import { createPluginMediaResultActionClient } from "../src/project-media-results-service.ts";
const query = { projectId: "project", runId: "original-run" };
test("an already cancelled action never reaches the host save or discovery service", async () => {
  let calls = 0;
  const client = createPluginMediaResultActionClient({
    invoke: async () => {
      calls++;
      throw new Error("must not call");
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.saveCandidate(
      { ...query, resultIndex: 0 },
      { signal: controller.signal },
    ),
  );
  await assert.rejects(
    client.listOutputs(query, { signal: controller.signal }),
  );
  assert.equal(calls, 0);
});
test("output metadata stays on its original run, positions are bounded, and caller URLs cannot be submitted", async () => {
  let calls = 0,
    value = {
      ...query,
      mediaInputId: "input",
      inputRevision: 1,
      outputs: [{ resultIndex: 0, candidate: null }],
    };
  const client = createPluginMediaResultActionClient({
    invoke: async () => {
      calls++;
      return value;
    },
  });
  assert.deepEqual(await client.listOutputs(query), value);
  value = { ...value, runId: "wrong" };
  await assert.rejects(client.listOutputs(query));
  value = {
    ...value,
    runId: query.runId,
    outputs: [{ resultIndex: 16, candidate: null }],
  };
  await assert.rejects(client.listOutputs(query));
  const before = calls;
  await assert.rejects(
    client.saveCandidate({
      ...query,
      resultIndex: 0,
      url: "https://caller/output.png",
    }),
  );
  assert.equal(calls, before);
});
test("a save response cannot claim a different project or output location", async () => {
  const candidate = {
    ...query,
    candidateId: "result-" + "a".repeat(64),
    resultIndex: 0,
    executionId: "execution",
    mediaInputId: "input",
    inputRevision: 1,
    workflowId: "krea2-reference-four-view",
    item: { kind: "character-reference", assetId: "character" },
    contentDigest: "sha256:" + "b".repeat(64),
    media: {
      type: "image/png",
      byteDigest: "sha256:" + "c".repeat(64),
      byteLength: 64,
      width: 512,
      height: 512,
      observedAt: "2026-10-07T00:00:00.000Z",
    },
  };
  let value = { disposition: "created", candidate };
  const client = createPluginMediaResultActionClient({
    invoke: async () => value,
  });
  assert.deepEqual(
    await client.saveCandidate({ ...query, resultIndex: 0 }),
    value,
  );
  value = { ...value, candidate: { ...candidate, resultIndex: 1 } };
  await assert.rejects(client.saveCandidate({ ...query, resultIndex: 0 }));
  value = { ...value, candidate: { ...candidate, projectId: "foreign" } };
  await assert.rejects(client.saveCandidate({ ...query, resultIndex: 0 }));
});
