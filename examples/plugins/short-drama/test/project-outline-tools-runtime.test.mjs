import assert from "node:assert/strict";
import test from "node:test";
import {
  fixture,
  projectId,
  sha,
} from "./project-foundation-tools-runtime.test-support.mjs";
const signal = new AbortController().signal;
const decode = (value) =>
  JSON.parse(JSON.parse(value.result.output).resultJson);
const request = {
  projectId,
  expectedFoundationRevision: 2,
  expectedArtifactRevision: 6,
  briefRevision: 1,
  baseContentRevision: 6,
  baseContentDigest: sha("base"),
  changeJsonParts: [
    JSON.stringify({
      kind: "upsert",
      collection: "episodes",
      items: [{ episodeId: "ep-1", title: "新标题" }],
      removeIds: [],
    }),
  ],
};
const result = {
  kind: "save-outline",
  disposition: "committed",
  projectId,
  artifactId: "outline-1",
  artifactRevision: 7,
  contentRevision: 7,
  contentDigest: sha("new"),
};
const context = {
  context: {
    projectId,
    briefRevision: 1,
    foundationRevision: 2,
    parametersRevision: 1,
    origin: "novel",
    parametersDigest: sha("parameters"),
    source: { revision: 1, digest: sha("source") },
    confirmedProposal: null,
  },
  page: { text: "{}", offset: 0, nextOffset: null, totalCodePoints: 2 },
};

test("installed outline tools forward original commands, retain candidate ACKs and cold reconcile through the new host service", async () => {
  const calls = [];
  const f = fixture({
    outlineHost: {
      async getContext(input) {
        calls.push(input);
        return context;
      },
      async saveCandidate(input) {
        calls.push(input);
        return {
          ...result,
          disposition: calls.length > 2 ? "replayed" : "committed",
        };
      },
    },
  });
  const read = f.command("outline_context", {
    projectId,
    expectedFoundationRevision: 0,
    offset: 0,
  });
  assert.deepEqual(decode(await f.runtime.execute(read, signal)), context);
  const command = f.command("outline_change", request);
  assert.deepEqual(decode(await f.runtime.execute(command, signal)), result);
  assert.equal(calls[1].command, command);
  assert.equal(calls[1].request.base.contentRevision, 6);
  assert.equal(calls[1].request.change.items[0].episodeId, "ep-1");
  const cold = f.create();
  assert.equal(
    decode(await cold.reconcile(command, signal)).disposition,
    "replayed",
  );
  assert.equal(f.oldCalls(), 0);
  await Promise.all([cold.close(), f.runtime.close()]);
});

test("outline runtime refuses missing independent service and mismatched policies without falling back to old writes", async () => {
  const missing = fixture(),
    command = missing.command("outline_change", request);
  await assert.rejects(
    missing.runtime.execute(command, signal),
    /outline_tools_unavailable/,
  );
  let calls = 0;
  const f = fixture({
    outlineHost: {
      async getContext() {
        return context;
      },
      async saveCandidate() {
        calls++;
        return result;
      },
    },
  });
  const bad = f.command("outline_change", request);
  bad.actionIntent.capability = "project.read";
  await assert.rejects(f.runtime.execute(bad, signal));
  assert.equal(calls, 0);
  assert.equal(f.oldCalls(), 0);
  await Promise.all([missing.runtime.close(), f.runtime.close()]);
});

test("a cancellation after a committed outline ACK preserves the durable saved fact", async () => {
  const abort = new AbortController();
  const f = fixture({
    outlineHost: {
      async getContext() {
        return context;
      },
      async saveCandidate() {
        abort.abort();
        return result;
      },
    },
  });
  const command = f.command("outline_change", request);
  assert.equal(
    decode(await f.runtime.execute(command, abort.signal)).disposition,
    "committed",
  );
  assert.equal(
    f.runtime.readRetainedExecutionResult({
      ...command,
    }).status,
    "completed",
  );
  await f.runtime.close();
});
