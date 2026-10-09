import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectOutlineToolsClient,
  parseProjectOutlineToolRequest,
  parseProjectOutlineToolResult,
  parseProjectOutlineToolCommand,
  parseProjectOutlineToolContext,
  parseProjectOutlineToolContextRequest,
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

test("outline model transport joins only bounded parts and preserves the exact observed base", () => {
  const text = JSON.stringify(request.change),
    command = {
      projectId: request.projectId,
      expectedFoundationRevision: request.expectedFoundationRevision,
      expectedArtifactRevision: request.expectedArtifactRevision,
      briefRevision: request.briefRevision,
      baseContentRevision: 6,
      baseContentDigest: digest,
      changeJsonParts: [text.slice(0, 10), text.slice(10)],
    };
  assert.deepEqual(parseProjectOutlineToolCommand(command), request);
  for (const invalid of [
    { ...command, idempotencyKey: "plugin-chosen" },
    { ...command, baseContentRevision: 0 },
    { ...command, changeJsonParts: ["x".repeat(10000)] },
    { ...command, changeJsonParts: Array.from({ length: 9 }, () => "") },
    { ...command, changeJsonParts: ["{}"] },
  ])
    assert.throws(() => parseProjectOutlineToolCommand(invalid));
});

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
    async getContext() {
      throw new Error("unused");
    },
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
    async getContext() {
      throw new Error("unused");
    },
    async saveCandidate() {
      return { ...result, projectId: "other" } as never;
    },
  });
  await assert.rejects(
    invalid.saveCandidate({ command, request: request as never }),
  );
});

test("outline context correlates project, observed Foundation revision and bounded Unicode pages", async () => {
  const request = {
    projectId: "original-project",
    expectedFoundationRevision: 0,
    offset: 0,
  };
  const result = {
    context: {
      projectId: request.projectId,
      briefRevision: 1,
      foundationRevision: 2,
      parametersRevision: 1,
      origin: "novel",
      parametersDigest: digest,
      source: { revision: 1, digest },
      confirmedProposal: null,
    },
    page: { text: "雨😀夜", offset: 0, nextOffset: null, totalCodePoints: 3 },
  };
  assert.deepEqual(parseProjectOutlineToolContext(request, result), result);
  for (const wrong of [
    { ...result, context: { ...result.context, projectId: "other" } },
    { ...result, context: { ...result.context, source: null } },
    { ...result, page: { ...result.page, nextOffset: 3 } },
    {
      ...result,
      page: { ...result.page, text: "x".repeat(1025), totalCodePoints: 1025 },
    },
  ])
    assert.throws(() => parseProjectOutlineToolContext(request, wrong));
  assert.throws(() =>
    parseProjectOutlineToolContext(
      { ...request, expectedFoundationRevision: 3 },
      result,
    ),
  );
  assert.throws(() =>
    parseProjectOutlineToolContextRequest({ ...request, offset: 1 }),
  );
  const command = Object.freeze({ executionId: "context-execution" });
  const client = createProjectOutlineToolsClient({
    async getContext(input) {
      assert.equal(input.command, command);
      return result as never;
    },
    async saveCandidate() {
      throw new Error("unused");
    },
  });
  assert.deepEqual(await client.getContext({ command, request }), result);
});
