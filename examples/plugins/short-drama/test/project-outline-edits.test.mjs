import assert from "node:assert/strict";
import test from "node:test";
import { ProjectOutlineEditController } from "../src/workbench/ProjectOutlineEditController.ts";
import {
  parseProjectOutlineEditRequest,
  parseProjectOutlineEditResult,
  createProjectOutlineEditsClient,
} from "../src/project-outline-edits-service.ts";
import { outlineReadFixture } from "./project-outline-read.test-support.mjs";

test("uncertain save holds navigation and retries the exact original request even after a newer head appears", async () => {
  const fixture = outlineReadFixture(),
    calls = [];
  const reader = {
    getSnapshot: () => ({
      state: "ready",
      view: fixture.view,
      revision: fixture.view.selectedRevision,
    }),
    refresh: async () => {},
    openRevision: async () => {},
  };
  let attempt = 0;
  const edits = new ProjectOutlineEditController({
    reader,
    physicalWritesPending: () => false,
    service: {
      service: "crewon.project-outline-edits",
      apiVersion: "1",
      async invoke(action, input, options) {
        assert.deepEqual(
          options,
          {},
          "desktop bridge requires an options record",
        );
        calls.push(structuredClone({ action, input }));
        if (++attempt === 1) throw Error("connection_closed");
        return {
          kind: "save-outline",
          disposition: "replayed",
          projectId: input.projectId,
          artifactId: "outline-artifact",
          artifactRevision: input.expectedArtifactRevision + 1,
          contentRevision: 3,
          contentDigest: "sha256:" + "3".repeat(64),
        };
      },
    },
  });
  edits.setReady(true);
  assert.equal(
    await edits.save({
      projectId: "outline-project",
      briefRevision: 1,
      change: {
        kind: "upsert",
        collection: "characters",
        items: [
          {
            id: "C1",
            name: "林雨",
            role: "摄影师",
            tier: "lead",
            from: ["第一章"],
          },
        ],
        removeIds: [],
      },
    }),
    false,
  );
  assert.equal(edits.locked, true);
  assert.equal(
    await edits.save({
      projectId: "other-project",
      briefRevision: 1,
      change: { kind: "initialize", document: {} },
    }),
    false,
  );
  fixture.view.artifact.revision = 8;
  assert.equal(await edits.retry(), true);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[1].input.expectedArtifactRevision, 3);
  assert.equal(calls[1].input.base.contentRevision, 1);
  assert.equal(edits.locked, false);
  edits.dispose();
});
test("outline edit client normalizes omitted options and preserves explicit cancellation", async () => {
  const calls = [];
  const client = createProjectOutlineEditsClient({
    service: "crewon.project-outline-edits",
    apiVersion: "1",
    async invoke(action, input, options) {
      assert.ok(options && typeof options === "object");
      calls.push(options);
      return {
        kind: "save-outline",
        disposition: "committed",
        projectId: input.projectId,
        artifactId: "outline-artifact",
        artifactRevision: input.expectedArtifactRevision + 1,
        contentRevision: 1,
        contentDigest: "sha256:" + "1".repeat(64),
      };
    },
  });
  const input = {
    projectId: "outline-project",
    briefRevision: 1,
    expectedArtifactRevision: 0,
    base: null,
    idempotencyKey: "outline-options",
    change: { kind: "initialize", document: {} },
  };
  await client.saveCandidate(input);
  const options = { signal: new AbortController().signal };
  await client.saveCandidate(input, options);
  assert.deepEqual(calls[0], {});
  assert.equal(calls[1], options);
});
test("corrupted acknowledgement preserves pending while a definite conflict leaves the user's draft retryable", async () => {
  const fixture = outlineReadFixture(),
    reader = {
      getSnapshot: () => ({
        state: "ready",
        view: fixture.view,
        revision: fixture.view.selectedRevision,
      }),
      refresh: async () => {},
      openRevision: async () => {},
    };
  let response = "bad";
  const edits = new ProjectOutlineEditController({
    reader,
    physicalWritesPending: () => false,
    service: {
      service: "crewon.project-outline-edits",
      apiVersion: "1",
      async invoke() {
        if (response === "bad") return { disposition: "committed" };
        throw Error("project_text_revision_conflict");
      },
    },
  });
  edits.setReady(true);
  await edits.save({
    projectId: "outline-project",
    briefRevision: 1,
    change: {
      kind: "upsert",
      collection: "episodes",
      items: [],
      removeIds: [],
    },
  });
  assert.equal(edits.getSnapshot().pending, true);
  response = "conflict";
  await edits.retry();
  assert.equal(edits.getSnapshot().pending, false);
  assert.match(edits.getSnapshot().error, /编辑仍保留/);
  edits.dispose();
});
test("write codec rejects unknown actions, hooks, invalid bases and uncorrelated acknowledgements", () => {
  const valid = {
    action: "crewon.project-outline-edits.v1.saveCandidate",
    input: {
      projectId: "p",
      expectedArtifactRevision: 0,
      idempotencyKey: "i",
      briefRevision: 1,
      base: null,
      change: { kind: "initialize", document: {} },
    },
  };
  const request = parseProjectOutlineEditRequest(valid);
  for (const raw of [
    { ...valid, action: "crewon.project-outlines.v2.saveCandidate" },
    {
      ...valid,
      input: {
        ...valid.input,
        base: { contentRevision: 1, contentDigest: "forged" },
      },
    },
    {
      ...valid,
      input: {
        ...valid.input,
        change: {
          get kind() {
            throw Error("hook executed");
          },
        },
      },
    },
  ])
    assert.throws(
      () => parseProjectOutlineEditRequest(raw),
      /contract_invalid/,
    );
  assert.throws(
    () =>
      parseProjectOutlineEditResult(request, {
        kind: "save-outline",
        disposition: "committed",
        projectId: "foreign",
        artifactId: "a",
        artifactRevision: 1,
        contentRevision: 1,
        contentDigest: "sha256:" + "a".repeat(64),
      }),
    /contract_invalid/,
  );
});
