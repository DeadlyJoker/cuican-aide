import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient } from "./control-api-client.ts";

const thread = {
  threadId: "thread-1",
  title: "Workspace task",
  status: "active",
  revision: 1,
  lastMessageSequence: 0,
  createdAt: "2026-09-14T00:00:00Z",
  updatedAt: "2026-09-14T00:00:00Z",
  archivedAt: null,
  deletedAt: null,
  forkedFromThreadId: null,
  forkedThroughHistorySequence: null,
};

test("authenticated snapshots retain workspace ownership and normalize legacy omission", async () => {
  for (const workspaceId of [undefined, null, "workspace-a"] as const) {
    const signal = new AbortController().signal;
    const client = new ControlApiClient({
      baseUrl: "https://control.example",
      accessToken: "named-test-token",
      fetch: async (input, init) => {
        assert.equal(
          String(input),
          "https://control.example/api/v1/threads/thread-1",
        );
        assert.equal(init?.signal, signal);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer named-test-token",
        );
        assert.equal(init?.method, "GET");
        return Response.json({
          eventSequence: 1,
          thread: {
            ...thread,
            ...(workspaceId === undefined ? {} : { workspaceId }),
          },
        });
      },
    });
    assert.deepEqual(await client.getThread("thread-1", { signal }), {
      eventSequence: 1,
      thread: { ...thread, workspaceId: workspaceId ?? null },
    });
  }
});

test("snapshot ownership rejects filesystem paths, invalid tokens and additional owner selectors", async () => {
  for (const malformed of [
    { workspaceId: "/Users/example/private" },
    { workspaceId: "" },
    { workspaceId: "space/other" },
    { workspaceId: 1 },
    { workspaceId: "a".repeat(129) },
    { workspaceId: "workspace-a", root: "/private" },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.example",
      fetch: async () =>
        Response.json({
          eventSequence: 1,
          thread: { ...thread, ...malformed },
        }),
    });
    await assert.rejects(
      client.getThread("thread-1"),
      /control_client_thread_snapshot_invalid/,
    );
  }
});

test("thread creation forwards the captured opaque workspace ID through the original transport", async () => {
  const signal = new AbortController().signal;
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "named-test-token",
    fetch: async (input, init) => {
      assert.equal(String(input), "https://control.example/api/v1/threads");
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, signal);
      assert.equal(
        new Headers(init?.headers).get("idempotency-key"),
        "workspace-create:1",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        title: null,
        workspaceId: "workspace-a",
      });
      return Response.json(
        {
          disposition: "committed",
          thread: { ...thread, workspaceId: "workspace-a" },
        },
        { status: 201 },
      );
    },
  });
  const result = await client.createThread(
    { title: null, workspaceId: "workspace-a" },
    "workspace-create:1",
    { signal },
  );
  assert.equal(result.thread.workspaceId, "workspace-a");
});
