import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectOutlineToolsClient,
  parseProjectOutlineToolRequest,
  parseProjectOutlineToolResult,
} from "./plugin-project-outline-tools-service.ts";

const digest = `sha256:${"a".repeat(64)}`;
const request = {
  projectId: "original-project",
  expectedFoundationRevision: 2,
  expectedArtifactRevision: 6,
  briefRevision: 1,
  base: { contentRevision: 6, contentDigest: digest },
  change: {
    kind: "upsert",
    collection: "episodes",
    items: [{ episodeId: "episode-1", ep: 1, title: "来自明天的信" }],
    removeIds: [],
  },
};
const result = {
  kind: "save-outline",
  disposition: "committed",
  projectId: request.projectId,
  artifactId: "original-outline",
  artifactRevision: 7,
  contentRevision: 7,
  contentDigest: digest,
};

test("outline tool transport detaches a bounded batch and retains stable identities", () => {
  const parsed = parseProjectOutlineToolRequest(request);
  assert.deepEqual(parsed, request);
  assert.notEqual(parsed, request);
  assert.ok(Object.isFrozen(parsed.change));
  assert.ok(Object.isFrozen(parsed.change.items));
  assert.deepEqual(parseProjectOutlineToolResult(parsed, result), result);
});

test("outline tool transport cannot accept UI keys, legacy text or implicit base", () => {
  for (const invalid of [
    { ...request, idempotencyKey: "plugin-chosen" },
    { ...request, expectedFoundationRevision: 0 },
    { ...request, change: { text: "legacy outline" } },
    { ...request, base: null },
    { ...request, change: { kind: "initialize", document: {} } },
    { ...request, change: { ...request.change, collection: "scripts" } },
    { ...request, base: { ...request.base, contentDigest: "not-a-digest" } },
  ])
    assert.throws(() => parseProjectOutlineToolRequest(invalid));
  assert.equal(
    parseProjectOutlineToolRequest({
      ...request,
      expectedArtifactRevision: 0,
      base: null,
      change: { kind: "initialize", document: {} },
    }).base,
    null,
  );
});

test("outline tool result must correlate to the exact project and next artifact head", () => {
  for (const invalid of [
    { ...result, projectId: "other-project" },
    { ...result, artifactRevision: 8 },
    { ...result, disposition: "selected" },
    { ...result, text: "unbounded output" },
    { ...result, contentRevision: 0 },
  ])
    assert.throws(() =>
      parseProjectOutlineToolResult(request as never, invalid),
    );
  assert.equal(
    parseProjectOutlineToolResult(request as never, {
      ...result,
      disposition: "replayed",
    }).disposition,
    "replayed",
  );
});

test("outline tool transport rejects hooks, cycles, sparse arrays and excessive batches", () => {
  let hooks = 0;
  const accessor = { ...request };
  Object.defineProperty(accessor, "projectId", {
    enumerable: true,
    get() {
      hooks++;
      return "original-project";
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const change of [
    { ...request.change, items: new Array(1) },
    { ...request.change, items: Array.from({ length: 11 }, () => ({})) },
    { ...request.change, items: [cycle] },
    {
      ...request.change,
      toJSON() {
        hooks++;
        return {};
      },
    },
    { ...request.change, items: [{ title: "图".repeat(20_000) }] },
    { ...request.change, items: [{ title: "\ud800" }] },
  ])
    assert.throws(() => parseProjectOutlineToolRequest({ ...request, change }));
  assert.throws(() => parseProjectOutlineToolRequest(accessor));
  assert.equal(hooks, 0);
});

test("outline client forwards the genuine command object unchanged and validates acknowledgements", async () => {
  const command = Object.freeze({ executionId: "actual-execution" });
  const client = createProjectOutlineToolsClient({
    async saveCandidate(input) {
      assert.equal(input.command, command);
      assert.notEqual(input.request, request);
      return result as never;
    },
  });
  assert.equal(
    (await client.saveCandidate({ command, request: request as never }))
      .artifactRevision,
    7,
  );
  const invalid = createProjectOutlineToolsClient({
    async saveCandidate() {
      return { ...result, projectId: "other" } as never;
    },
  });
  await assert.rejects(
    invalid.saveCandidate({ command, request: request as never }),
  );
});
