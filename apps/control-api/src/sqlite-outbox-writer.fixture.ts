import { SqliteRunStore } from "@crewon/store";
import type { RunLifecycleEvent } from "@crewon/domain";

const store = new SqliteRunStore(process.argv[2]!);
const runId = process.argv[3]!;
let operation = Promise.resolve();
process.on("message", (input: unknown) => {
  operation = operation
    .then(async () => {
      if (input === "close") {
        await store.close();
        process.disconnect();
        return;
      }
      if (
        typeof input !== "object" ||
        input === null ||
        !("kind" in input) ||
        !("delta" in input) ||
        input.kind !== "append" ||
        typeof input.delta !== "string"
      )
        throw new Error("fixture_input_invalid");
      const state = await store.loadRun({ tenantId: "wake-tenant", runId });
      if (state === null) throw new Error("fixture_run_missing");
      const sequence = state.lastSequence + 1;
      const event: RunLifecycleEvent = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId },
        eventId: `${runId}:${sequence}`,
        sequence,
        occurredAt: new Date().toISOString(),
        type: "model.output.delta",
        data: {
          segmentId: "wake-segment",
          segmentSequence: sequence - 2,
          delta: input.delta,
        },
      };
      await store.commitRun({
        tenantId: "wake-tenant",
        idempotency: {
          scope: "wake-child",
          key: String(sequence),
          requestFingerprint: event.eventId,
        },
        expectedRevision: state.revision,
        events: [event],
        outbox: [
          {
            messageId: `wake-message-${sequence}`,
            tenantId: "wake-tenant",
            runId,
            topic: "run.events.available",
            createdAt: event.occurredAt,
            payload: {
              schemaVersion: "crewon.run-event-range.v0",
              fromSequence: sequence,
              throughSequence: sequence,
              firstEventId: event.eventId,
              lastEventId: event.eventId,
            },
          },
        ],
        workItems: [],
      });
      process.send?.({
        kind: "committed",
        sequence,
        committedAt: Date.now(),
        pid: process.pid,
      });
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "fixture_failed"}\n`,
      );
      process.exitCode = 1;
      process.disconnect();
    });
});
process.send?.({ kind: "ready", pid: process.pid });
