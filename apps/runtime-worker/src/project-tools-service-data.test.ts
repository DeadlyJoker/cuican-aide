import assert from "node:assert/strict";
import test from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import { MAX_PROJECT_TOOLS_RESPONSE_BYTES } from "@crewon/contracts/project-tools";
import { parseProjectToolsRequest } from "./plugins/project-tools-service-request.ts";
import {
  boundedProjectToolsResponse,
  projectToolsContent,
} from "./plugins/project-tools-service-projection.ts";

const outline = {
  title: "夜航",
  logline: "来信",
  synopsis: "雨夜",
  episodes: [{ episodeId: "e1", title: "第一集", summary: "发现来信" }],
};
const script = {
  title: "第一集",
  scenes: [
    {
      sceneId: "s1",
      location: "街口",
      timeOfDay: "夜",
      action: "等待",
      dialogue: [],
    },
  ],
};

test("project tool requests normalize only documented omitted nullable fields", () => {
  assert.deepEqual(
    parseProjectToolsRequest("listProjects", { state: "all", limit: 4 }),
    { state: "all", limit: 4, after: null },
  );
  const request = {
    projectId: "p1",
    episodeId: "e1",
    expectedArtifactRevision: 0,
    briefRevision: 1,
    content: script,
  };
  assert.deepEqual(parseProjectToolsRequest("saveScriptCandidate", request), {
    ...request,
    outline: null,
  });
  assert.deepEqual(
    parseProjectToolsRequest("saveOutlineCandidate", {
      projectId: "p1",
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: outline,
    }),
    {
      projectId: "p1",
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: outline,
    },
  );
});

test("all twelve requests validate exact business fields and bounded pages", () => {
  const inputs = {
    listProjects: {
      state: "active",
      after: { updatedAt: "2026-10-05T00:00:00.000Z", projectId: "p1" },
      limit: 1,
    },
    readProject: { projectId: "p1" },
    createProject: { title: "夜航", briefText: "来信" },
    appendBrief: { projectId: "p1", expectedProjectRevision: 1, text: "雨夜" },
    readOutline: { projectId: "p1" },
    readScript: { projectId: "p1", episodeId: "e1" },
    readContent: {
      projectId: "p1",
      source: { kind: "brief", briefRevision: 1 },
      offset: 0,
    },
    listRevisions: {
      projectId: "p1",
      artifactId: "a1",
      afterContentRevision: 0,
      limit: 4,
    },
    saveOutlineCandidate: {
      projectId: "p1",
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: outline,
    },
    saveScriptCandidate: {
      projectId: "p1",
      episodeId: "e1",
      expectedArtifactRevision: 0,
      briefRevision: 1,
      outline: null,
      content: script,
    },
    selectRevision: {
      projectId: "p1",
      artifactId: "a1",
      expectedArtifactRevision: 1,
      contentRevision: 1,
    },
    setLocked: {
      projectId: "p1",
      artifactId: "a1",
      expectedArtifactRevision: 1,
      locked: true,
    },
  } as const;
  for (const [method, input] of Object.entries(inputs)) {
    assert.deepEqual(
      parseProjectToolsRequest(method as keyof typeof inputs, input),
      input,
    );
    for (const extra of [
      { actor: "forged" },
      { idempotencyKey: "forged" },
      { signal: {} },
      { surprise: true },
    ])
      assert.throws(() =>
        parseProjectToolsRequest(method as keyof typeof inputs, {
          ...input,
          ...extra,
        }),
      );
  }
  for (const limit of [0, 5, -1, 1.5])
    assert.throws(() =>
      parseProjectToolsRequest("listProjects", { state: "all", limit }),
    );
  for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      parseProjectToolsRequest("readContent", {
        projectId: "p1",
        source: { kind: "brief", briefRevision: 1 },
        offset,
      }),
    );
  assert.throws(() =>
    parseProjectToolsRequest("readContent", {
      projectId: "p1",
      source: { kind: "brief", briefRevision: 1, artifactId: "forged" },
      offset: 0,
    }),
  );
  assert.throws(() =>
    parseProjectToolsRequest("readProject", { projectId: ".." }),
  );
});

test("data capture never evaluates getters or toJSON and preserves creative bytes", () => {
  let calls = 0;
  assert.throws(() =>
    parseProjectToolsRequest("readProject", {
      get projectId() {
        calls++;
        return "p1";
      },
    }),
  );
  assert.throws(() =>
    parseProjectToolsRequest("readProject", {
      projectId: "p1",
      toJSON() {
        calls++;
        return { projectId: "p1" };
      },
    }),
  );
  assert.equal(calls, 0);
  const input = { title: "夜航", briefText: "  保留空格\n🚀\t  " };
  assert.deepEqual(parseProjectToolsRequest("createProject", input), input);
  assert.throws(() =>
    parseProjectToolsRequest("createProject", { ...input, title: " 夜航 " }),
  );
});

test("Unicode codepoint pages reconstruct exact immutable source within final Tool JSON budget", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  for (const source of [
    '🚀界"\\\t\n'.repeat(1600),
    '"'.repeat(4096),
    "\\".repeat(4096),
    "\r\n\t".repeat(1500),
    "界".repeat(10000),
  ]) {
    const chunks: string[] = [];
    let offset = 0;
    do {
      const result = boundedProjectToolsResponse(
        projectToolsContent(digest, "text", source, offset),
      );
      assert.equal(result.contentDigest, digest);
      assert.equal(result.totalCodePoints, Array.from(source).length);
      assert.ok(Array.from(result.text).length <= 1024);
      assert.ok(
        Buffer.byteLength(
          extensionCanonicalJson({
            resultJson: extensionCanonicalJson(result),
          }),
          "utf8",
        ) <= MAX_PROJECT_TOOLS_RESPONSE_BYTES,
      );
      chunks.push(result.text);
      if (result.nextOffset === null) break;
      assert.ok(result.nextOffset > offset);
      offset = result.nextOffset;
    } while (true);
    assert.equal(chunks.join(""), source);
    assert.equal(
      projectToolsContent(digest, "text", source, Array.from(source).length)
        .text,
      "",
    );
    assert.throws(() =>
      projectToolsContent(
        digest,
        "text",
        source,
        Array.from(source).length + 1,
      ),
    );
  }
  assert.throws(
    () => boundedProjectToolsResponse({ text: "x".repeat(8192) }),
    /response_budget_exceeded/,
  );
});
