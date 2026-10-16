import assert from "node:assert/strict";
import test from "node:test";
import { MAX_THREAD_TRANSCRIPT_SNAPSHOT_RESPONSE_BYTES } from "@crewon/contracts";
import { transcriptSnapshotFixture } from "../../contracts/src/thread-transcript-snapshot.test-support.ts";
import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

test("snapshot client sends one bounded request with credentials and caller cancellation", async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.example",
    accessToken: "fixture-token",
    fetch: async (url, init) => {
      requests++;
      assert.equal(
        String(url),
        "https://control.example/api/v1/threads/thread-1/transcript-snapshot?limit=1",
      );
      assert.equal(init?.signal, controller.signal);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fixture-token",
      );
      return Response.json(transcriptSnapshotFixture());
    },
  });
  const snapshot = await client.getThreadTranscriptSnapshot(
    "thread-1",
    { limit: 1 },
    { signal: controller.signal },
  );
  assert.equal(snapshot.activeRunId, "run-1");
  assert.equal(requests, 1);
});
test("snapshot client fails closed on incomplete Run sets and cancels oversized streams", async () => {
  const fixture = transcriptSnapshotFixture();
  const invalid = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () => Response.json({ ...fixture, runs: [] }),
  });
  await assert.rejects(
    invalid.getThreadTranscriptSnapshot("thread-1"),
    ControlApiProtocolError,
  );
  let reads = 0,
    canceled = false;
  const chunk = new Uint8Array(256 * 1024).fill(32);
  const oversized = new ControlApiClient({
    baseUrl: "https://control.example",
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            reads++;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    oversized.getThreadTranscriptSnapshot("thread-1"),
    ControlApiProtocolError,
  );
  assert.equal(canceled, true);
  assert.ok(
    reads <=
      MAX_THREAD_TRANSCRIPT_SNAPSHOT_RESPONSE_BYTES / chunk.byteLength + 2,
  );
});
