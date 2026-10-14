import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectConversationContextResponse as parse } from "./project-conversation-context.ts";
const at = "2026-10-14T00:00:00.000Z";
const binding = {
  bindingId: "b",
  projectId: "p",
  threadId: "t",
  workspaceId: "w",
  revision: 1,
  state: "active",
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "crewon.example",
    version: "54.0.0",
    packageDigest: "sha256:" + "a".repeat(64),
    selectionRevision: 1,
  },
  createdAt: at,
  updatedAt: at,
};
const context = {
  binding,
  projectRevision: 2,
  briefRevision: 1,
  outline: {
    artifactId: "outline",
    contentRevision: 1,
    episodes: [{ episodeId: "one", title: "第一集" }],
  },
};
test("bound context is detached and retains all adopted episode identities without exposing text or authority", () => {
  const result = parse("t", { context });
  assert.deepEqual(result, { context });
  assert.ok(Object.isFrozen(result.context?.outline?.episodes));
  assert.deepEqual(parse("t", { context: null }), { context: null });
  const full = {
    ...context,
    outline: {
      ...context.outline,
      episodes: Array.from({ length: 240 }, (_, n) => ({
        episodeId: "ep" + n,
        title: "剧集".repeat(80),
      })),
    },
  };
  assert.equal(
    parse("t", { context: full }).context!.outline!.episodes.length,
    240,
  );
});
test("foreign Thread, extra grants, duplicate episodes, getters and oversized directories fail closed", () => {
  for (const value of [
    { context: { ...context, binding: { ...binding, threadId: "foreign" } } },
    { context: { ...context, actor: "forged" } },
    {
      context: {
        ...context,
        outline: {
          ...context.outline,
          episodes: [context.outline.episodes[0], context.outline.episodes[0]],
        },
      },
    },
    {
      context: {
        ...context,
        outline: {
          ...context.outline,
          episodes: Array.from({ length: 241 }, (_, n) => ({
            episodeId: "ep" + n,
            title: "集",
          })),
        },
      },
    },
  ])
    assert.throws(() => parse("t", value));
  let observed = false;
  const episodes = [context.outline.episodes[0]];
  Object.defineProperty(episodes, "0", {
    enumerable: true,
    get() {
      observed = true;
      return context.outline.episodes[0];
    },
  });
  assert.throws(() =>
    parse("t", {
      context: { ...context, outline: { ...context.outline, episodes } },
    }),
  );
  assert.equal(observed, false);
});
