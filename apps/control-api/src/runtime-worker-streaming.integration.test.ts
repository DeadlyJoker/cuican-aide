import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ControlApiClient, streamRunEvents } from "@crewon/control-client";
import type { RunEventView } from "@crewon/contracts";
import {
  fixture,
  waitFor,
} from "../../runtime-worker/src/runtime-worker-pool.test-support.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";
import { watchSqliteOutboxAvailability } from "./sqlite-outbox-wakeup.ts";

const SESSION = "parallel-stream-session-at-least-32-bytes";
const CSRF = "parallel-stream-csrf-at-least-32-bytes";
const ORIGIN = "http://127.0.0.1:5175";

test(
  "real HTTP SSE delivers parallel Runs independently and reconnects without replaying model work",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, 60_000);
    const control = createStandaloneControlApi({
      databasePath: f.databasePath,
      actor: f.actor,
      defaultAgentVersionId: "pool-agent",
      sessionToken: SESSION,
      csrfToken: CSRF,
      allowedOrigins: [ORIGIN],
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "parallel-test-key",
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: 60_000,
      outboxRetention: null,
      artifactRetention: null,
      automationScanIntervalMs: null,
    });
    const hints = watchSqliteOutboxAvailability({
      databasePath: f.databasePath,
      outbox: control.outboxDispatcher,
    });
    const controllers: AbortController[] = [];
    t.after(async () => {
      controllers.forEach((c) => c.abort());
      hints.close();
      await control.app.close();
    });
    await control.app.listen({ host: "127.0.0.1", port: 0 });
    const address = control.app.server.address();
    assert.ok(address && typeof address !== "string");
    const client = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      accessToken: SESSION,
      csrfToken: CSRF,
      origin: ORIGIN,
    });
    f.runtime.start();
    const first = await f.enqueue("SSE slow"),
      second = await f.enqueue("SSE fast");
    const open = (runId: string, afterSequence = 0) => {
      const controller = new AbortController();
      controllers.push(controller);
      const events: RunEventView[] = [];
      const settled = (async () => {
        try {
          for await (const event of streamRunEvents(client, {
            runId,
            afterSequence,
            view: "transcript",
            signal: controller.signal,
          }))
            events.push(event);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
      })();
      return { events, controller, settled };
    };
    const a = open(first.runId),
      b = open(second.runId);
    await waitFor(() =>
      [a, b].every((s) =>
        s.events.some((e) => e.type === "model.output.delta"),
      ),
    );
    assert.equal((await f.load(first.runId))?.status, "running");
    assert.equal((await f.load(second.runId))?.status, "running");
    const cursor = a.events.at(-1)!.sequence;
    a.controller.abort();
    await a.settled;
    const resumed = open(first.runId, cursor);
    const releasedAt = performance.now();
    f.release(second.runId);
    await b.settled;
    assert.equal(b.events.at(-1)?.type, "run.completed");
    assert.equal((await f.load(first.runId))?.status, "running");
    f.release(first.runId);
    await resumed.settled;
    assert.equal(resumed.events.at(-1)?.type, "run.completed");
    assert.ok(resumed.events.every((e) => e.sequence > cursor));
    for (const [id, stream] of [
      [first.runId, [...a.events, ...resumed.events]],
      [second.runId, b.events],
    ] as const) {
      assert.ok(stream.every((e) => e.runId === id));
      assert.equal(new Set(stream.map((e) => e.sequence)).size, stream.length);
    }
    for (const run of [first, second]) {
      const history = await client.listThreadMessages(run.threadId);
      assert.deepEqual(
        history.data.map((message) => message.content),
        [run.label, `answer:${run.runId}`],
      );
    }
    assert.equal(
      f.entered.size,
      2,
      "reconnect must not dispatch another model request",
    );
    t.diagnostic(
      JSON.stringify({
        scenario: "HTTP-SSE",
        releaseToVisibleCompletionMs: performance.now() - releasedAt,
        maximumActive: f.maximumActive(),
      }),
    );
  },
);
