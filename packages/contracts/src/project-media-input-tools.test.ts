import assert from "node:assert/strict";
import test from "node:test";
import * as host from "./project-media-input-tools.ts";
const portable = (await import(
  new URL(
    "../../../examples/plugins/short-drama/src/project-media-input-tools-codec.mjs",
    import.meta.url,
  ).href
)) as typeof host;
import type { PublicMediaInput } from "./project-media-inputs.ts";
const request = {
  projectId: "project",
  mediaInputId: null,
  expectedInputRevision: 0,
  item: { kind: "character-reference" as const, assetId: "character" },
  briefRevision: 1,
  script: null,
  workflowId: "krea2-reference-four-view" as const,
  configurationRevision: 2,
  prompt: "Clear four-view reference",
  references: {
    character: {
      projectId: "project",
      assetId: "character",
      kind: "character" as const,
      expectedAssetRevision: 3,
      contentRevision: 1,
      referenceRevision: 2,
    },
  },
};
const input: PublicMediaInput = {
  ...request,
  mediaInputId: "input",
  inputRevision: 1,
  createdAt: "2026-10-06T00:00:00.000Z",
  contentDigest: `sha256:${"a".repeat(64)}`,
};
delete (input as unknown as Record<string, unknown>).expectedInputRevision;

for (const [label, codec] of [
  ["host", host],
  ["portable plugin", portable],
] as const) {
  const {
    parseMediaInputToolCommand,
    parseMediaInputToolRequest,
    parseMediaInputToolResponse,
    mediaInputToolMetadata,
    assertMediaInputToolResponseBudget,
  } = codec;

  test(
    label +
      ": " +
      "media tool commands exclude host keys, provider targets and undeclared methods",
    () => {
      assert.deepEqual(
        parseMediaInputToolCommand({
          method: "saveInput",
          requestJson: JSON.stringify(request),
        }),
        { method: "saveInput", request },
      );
      for (const patch of [
        { idempotencyKey: "model-key" },
        { target: { profileId: "foreign" } },
        { serviceUrl: "https://example.com" },
      ])
        assert.throws(() =>
          parseMediaInputToolRequest("saveInput", { ...request, ...patch }),
        );
      assert.throws(() =>
        parseMediaInputToolCommand({ method: "execute", requestJson: "{}" }),
      );
      assert.throws(() =>
        parseMediaInputToolCommand({
          method: "getContext",
          requestJson: "{}",
          extra: true,
        }),
      );
      assert.throws(() =>
        parseMediaInputToolRequest("getContext", { projectId: "foreign" }),
      );
      assert.throws(() =>
        parseMediaInputToolRequest("listInputs", {
          projectId: "project",
          afterMediaInputId: null,
          limit: 5,
        }),
      );
    },
  );
  test(
    label +
      ": " +
      "save acknowledgement correlates exact logical inputs while excluding prompt and private evidence",
    () => {
      const metadata = mediaInputToolMetadata(input),
        value = { disposition: "committed" as const, input: metadata };
      assert.equal(Object.hasOwn(metadata, "prompt"), false);
      assert.deepEqual(
        parseMediaInputToolResponse("saveInput", request, value),
        value,
      );
      for (const patch of [
        { projectId: "foreign" },
        { inputRevision: 2 },
        { configurationRevision: 3 },
        { prompt: "secret" },
        { target: { serviceUrl: "https://example.com" } },
      ])
        assert.throws(() =>
          parseMediaInputToolResponse("saveInput", request, {
            ...value,
            input: { ...metadata, ...patch },
          }),
        );
      assert.throws(() =>
        parseMediaInputToolResponse(
          "getInput",
          { projectId: "project", mediaInputId: "input", inputRevision: 2 },
          { state: { input: metadata, latestInputRevision: 2 } },
        ),
      );
    },
  );
  test(
    label +
      ": " +
      "prompt chunks correlate immutable identity and code-point offsets, rejecting surrogate and oversize fragments",
    () => {
      const q = {
        projectId: "project",
        mediaInputId: "input",
        inputRevision: 1,
        offset: 0,
      };
      const chunk = {
        ...q,
        contentDigest: input.contentDigest,
        text: "🚀界",
        nextOffset: 2,
        totalCodePoints: 3,
      };
      assert.deepEqual(
        parseMediaInputToolResponse("readPrompt", q, chunk),
        chunk,
      );
      for (const patch of [
        { mediaInputId: "foreign" },
        { inputRevision: 2 },
        { offset: 1 },
        { nextOffset: 3 },
        { text: "\ud800" },
        { text: "界".repeat(683) },
        { text: "", nextOffset: 0 },
      ])
        assert.throws(() =>
          parseMediaInputToolResponse("readPrompt", q, { ...chunk, ...patch }),
        );
      assert.deepEqual(
        parseMediaInputToolResponse(
          "readPrompt",
          { ...q, offset: 3 },
          { ...chunk, offset: 3, text: "", nextOffset: null },
        ),
        { ...chunk, offset: 3, text: "", nextOffset: null },
      );
    },
  );
  test(
    label +
      ": " +
      "8192-byte limit includes JSON string escaping in the real Tool result envelope",
    () => {
      const value = { text: "\\".repeat(2050) };
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 8192);
      assert.throws(() => assertMediaInputToolResponseBudget(value));
    },
  );
  test(
    label +
      ": " +
      "scope discloses only fixed logical task fields; D18 requires exact script identity",
    () => {
      const context = {
        projectId: "project",
        runId: "run",
        threadId: "thread",
        workspaceId: "workspace",
        bindingRevision: 1,
        workflowId: request.workflowId,
        configurationRevision: 2,
        briefRevision: 1,
        script: null,
      };
      assert.deepEqual(
        parseMediaInputToolResponse("getContext", {}, context),
        context,
      );
      assert.throws(() =>
        parseMediaInputToolResponse(
          "getContext",
          {},
          { ...context, workflowId: "flux2-three-reference-storyboard" },
        ),
      );
      assert.throws(() =>
        parseMediaInputToolResponse(
          "getContext",
          {},
          { ...context, providerUrl: "https://example.com" },
        ),
      );
    },
  );
}
