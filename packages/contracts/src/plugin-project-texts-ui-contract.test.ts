import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPluginProjectTextUiClient,
  PROJECT_TEXT_UI_METHOD_ACTIONS as A,
  PROJECT_TEXT_UI_ACTIONS,
  pluginUiActionInputMaximumBytes,
  parseProjectTextUiActionRequest,
  parseProjectTextUiActionResponse,
  projectTextsUiCodec,
  type ProjectTextUiActionRequest,
  type PluginProjectTextUiServices,
} from "./project-texts-ui.ts";
import { parseInvokePluginUiActionRequest } from "./plugin-control-contract.ts";
import {
  publicTextArtifact,
  publicTextOutline,
  publicTextRevision,
  publicTextScript,
  publicTextView,
  textProjectId,
  textEpisodeId,
} from "./project-text-control.test-support.ts";
const projectId = textProjectId,
  artifactId = "outline";
const invalid = { code: "plugin_project_text_ui_invalid" };
const requests: readonly ProjectTextUiActionRequest[] = [
  { action: A.getOutline, input: { projectId } },
  { action: A.getScript, input: { projectId, episodeId: textEpisodeId } },
  { action: A.getArtifact, input: { projectId, artifactId } },
  {
    action: A.getRevision,
    input: { projectId, artifactId, contentRevision: 1 },
  },
  {
    action: A.listArtifacts,
    input: { projectId, afterArtifactId: null, limit: 16 },
  },
  {
    action: A.listRevisions,
    input: { projectId, artifactId, afterContentRevision: 0, limit: 16 },
  },
  {
    action: A.saveOutlineCandidate,
    input: {
      projectId,
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: publicTextOutline,
      },
      idempotencyKey: "outline-once",
    },
  },
  {
    action: A.saveScriptCandidate,
    input: {
      projectId,
      episodeId: textEpisodeId,
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: publicTextScript,
      },
      idempotencyKey: "script-once",
    },
  },
  {
    action: A.selectRevision,
    input: {
      projectId,
      artifactId,
      request: { expectedArtifactRevision: 1, contentRevision: 1 },
      idempotencyKey: "select-once",
    },
  },
  {
    action: A.setLocked,
    input: {
      projectId,
      artifactId,
      request: { expectedArtifactRevision: 2, locked: true },
      idempotencyKey: "lock-once",
    },
  },
];
test("independent public file has no imports; all ten actions retain the original HTTP request shapes", () => {
  const source = readFileSync(
    new URL("./plugin-project-texts-ui-service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.equal(
    readFileSync(
      new URL(
        "../../../examples/plugins/short-drama/src/project-texts-ui-service.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    source,
  );
  assert.equal(PROJECT_TEXT_UI_ACTIONS.length, 10);
  for (const request of requests) {
    const result = parseProjectTextUiActionRequest(request);
    assert.deepEqual(result, request);
    assert.ok(Object.isFrozen(result.input));
  }
});
test("independently bundled public UI codec retains the canonical request and response validation", async () => {
  const { projectTextsUiCodec: bundled } = (await import(
    new URL(
      "../../../examples/plugins/short-drama/src/project-texts-ui-codec.mjs",
      import.meta.url,
    ).href
  )) as { projectTextsUiCodec: typeof projectTextsUiCodec };
  for (const request of requests)
    assert.deepEqual(
      bundled.parseRequest(request),
      projectTextsUiCodec.parseRequest(request),
    );
  for (const [request, response] of [
    [requests[0]!, { view: publicTextView }],
    [requests[1]!, { view: null }],
    [requests[2]!, { view: publicTextView }],
    [requests[3]!, { contentRevision: publicTextRevision }],
    [requests[4]!, { artifacts: [publicTextArtifact], nextArtifactId: null }],
    [
      requests[5]!,
      { revisions: [publicTextRevision], nextContentRevision: null },
    ],
  ] as const) {
    assert.deepEqual(
      bundled.parseResponse(request, response),
      projectTextsUiCodec.parseResponse(request, response),
    );
    assert.throws(
      () => bundled.parseResponse(request, { ...response, actorId: "caller" }),
      invalid,
    );
  }
  for (const request of [
    { action: A.getOutline, input: { projectId, actorId: "caller" } },
    { action: "crewon.project-texts.v2.getOutline", input: { projectId } },
    {
      action: A.listRevisions,
      input: { projectId, artifactId, limit: 17, afterContentRevision: 0 },
    },
  ])
    assert.throws(() => bundled.parseRequest(request), invalid);
});
test("request parser rejects identities, unknown versions, repeated keys, accessors and invalid cursors", () => {
  let getterCalls = 0;
  const accessor = { projectId };
  Object.defineProperty(accessor, "extra", {
    enumerable: true,
    get: () => {
      getterCalls++;
      return "secret";
    },
  });
  for (const input of [
    { action: "crewon.project-texts.v2.getOutline", input: { projectId } },
    { action: "crewon.creative-projects.v1.getProject", input: { projectId } },
    { action: A.getOutline, input: { projectId, actorId: "actor" } },
    { action: A.getOutline, input: accessor },
    {
      action: A.listArtifacts,
      input: { projectId, afterArtifactId: null, limit: 17 },
    },
    {
      action: A.listRevisions,
      input: { projectId, artifactId, afterContentRevision: -1, limit: 1 },
    },
    {
      ...requests[6],
      input: { ...requests[6]!.input, idempotencyKey: "one,two" },
    },
    {
      ...requests[7],
      input: {
        projectId,
        episodeId: textEpisodeId,
        request: {
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: publicTextScript,
        },
        idempotencyKey: "once",
      },
    },
  ])
    assert.throws(() => parseProjectTextUiActionRequest(input), invalid);
  assert.equal(getterCalls, 0);
});
test("new exact namespace accepts a complete supported script above24K while every older and unknown action retains24K", () => {
  const content = {
    title: "完整剧本",
    scenes: Array.from({ length: 4 }, (_, index) => ({
      sceneId: `scene-${index}`,
      location: "室内",
      timeOfDay: "夜",
      action: "x".repeat(7000),
      dialogue: [],
    })),
  };
  const request = {
    action: A.saveScriptCandidate,
    input: {
      projectId,
      episodeId: textEpisodeId,
      request: {
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content,
      },
      idempotencyKey: "large-once",
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(request.input)) > 24 * 1024);
  assert.deepEqual(parseInvokePluginUiActionRequest(request), request);
  assert.deepEqual(parseProjectTextUiActionRequest(request), request);
  for (const action of [
    "echo",
    "crewon.creative-projects.v1.appendBrief",
    "crewon.project-texts.v1.unknown",
    "crewon.project-texts.v2.saveScriptCandidate",
  ]) {
    assert.equal(pluginUiActionInputMaximumBytes(action), 24 * 1024);
    assert.throws(() =>
      parseInvokePluginUiActionRequest({ ...request, action }),
    );
  }
});
test("responses remain bound to the original project, artifact, immutable revision and mutation CAS", () => {
  assert.deepEqual(
    parseProjectTextUiActionResponse(requests[0]!, { view: publicTextView }),
    { view: publicTextView },
  );
  assert.deepEqual(
    parseProjectTextUiActionResponse(requests[3]!, {
      contentRevision: publicTextRevision,
    }),
    { contentRevision: publicTextRevision },
  );
  assert.deepEqual(
    parseProjectTextUiActionResponse(requests[4]!, {
      artifacts: [publicTextArtifact],
      nextArtifactId: null,
    }),
    { artifacts: [publicTextArtifact], nextArtifactId: null },
  );
  assert.deepEqual(
    parseProjectTextUiActionResponse(requests[5]!, {
      revisions: [publicTextRevision],
      nextContentRevision: null,
    }),
    { revisions: [publicTextRevision], nextContentRevision: null },
  );
  const mutation = {
    kind: "save-outline",
    disposition: "committed",
    artifact: publicTextArtifact,
    contentRevision: publicTextRevision,
  };
  assert.deepEqual(
    parseProjectTextUiActionResponse(requests[6]!, mutation),
    mutation,
  );
  for (const result of [
    { ...mutation, artifact: { ...publicTextArtifact, projectId: "other" } },
    { ...mutation, artifact: { ...publicTextArtifact, revision: 2 } },
    {
      ...mutation,
      contentRevision: {
        ...publicTextRevision,
        content: { ...publicTextOutline, synopsis: "changed" },
      },
    },
    { ...mutation, actorId: "leaked" },
  ])
    assert.throws(
      () => parseProjectTextUiActionResponse(requests[6]!, result),
      invalid,
    );
  assert.throws(
    () =>
      parseProjectTextUiActionResponse(requests[1]!, { view: publicTextView }),
    invalid,
  );
});
test("portable client captures its strict codec and dispatch, preserves signals and original keys, never auto-retries", async () => {
  const calls: unknown[] = [];
  const services: PluginProjectTextUiServices = {
    invoke: async (action, input, options) => {
      calls.push({ action, input, options });
      return { view: null };
    },
  };
  const codec = { ...projectTextsUiCodec };
  const client = createPluginProjectTextUiClient(services, codec);
  services.invoke = async () => {
    throw new Error("swapped-dispatch");
  };
  codec.parseRequest = () => {
    throw new Error("swapped-codec");
  };
  const controller = new AbortController();
  assert.deepEqual(
    await client.getOutline({ projectId }, { signal: controller.signal }),
    { view: null },
  );
  assert.deepEqual(calls[0], {
    action: A.getOutline,
    input: { projectId },
    options: { signal: controller.signal },
  });
  controller.abort();
  await assert.rejects(
    client.getOutline({ projectId }, { signal: controller.signal }),
    { name: "AbortError" },
  );
  const failing: PluginProjectTextUiServices = {
    invoke: async () => {
      calls.push("failed-once");
      throw new Error("lost-reply");
    },
  };
  const retry = createPluginProjectTextUiClient(failing, projectTextsUiCodec);
  await assert.rejects(
    retry.saveOutlineCandidate(requests[6]!.input as never),
    { message: "lost-reply" },
  );
  assert.equal(calls.filter((value) => value === "failed-once").length, 1);
});
