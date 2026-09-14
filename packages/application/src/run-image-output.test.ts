import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalAgentEvent } from "@crewon/contracts";
import type { RunLifecycleEvent } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { findImageEventReplay } from "./run-image-output.ts";
import { mapAgentEvent } from "./run-execution-support.ts";

const incoming: CanonicalAgentEvent = {
  schemaVersion: "crewon.agent-event.v0",
  runId: "run-1",
  segmentId: "segment-new",
  sequence: 1,
  type: "model.image.generated",
  data: {
    itemId: "image-1",
    artifactRef: "artifact-1",
    mimeType: "image/png",
    byteLength: 3_550_000,
  },
};
const state = { tenantId: "tenant-1", runId: "run-1", lastSequence: 1 };

test("image replay is independent of segment and rejects conflicting metadata", async () => {
  const first = lifecycle({ ...incoming, segmentId: "segment-old" });
  assert.equal(
    await findImageEventReplay(store([first]), state, incoming),
    first,
  );
  await assert.rejects(
    findImageEventReplay(store([first]), state, {
      ...incoming,
      data: { ...incoming.data, artifactRef: "artifact-conflict" },
    }),
    (error) =>
      error instanceof ApplicationError &&
      error.code === "model_image_output_conflict",
  );
});

test("replayed progress cannot regress a generated image or duplicate an earlier stage", async () => {
  const progress: CanonicalAgentEvent = {
    ...incoming,
    type: "model.image.progress",
    data: { itemId: "image-1", stage: "generating" },
  };
  const oldProgress = lifecycle(progress);
  assert.equal(
    await findImageEventReplay(store([oldProgress]), state, progress),
    oldProgress,
  );
  assert.equal(
    await findImageEventReplay(store([oldProgress]), state, incoming),
    null,
  );
  const generated = lifecycle(incoming);
  assert.equal(
    await findImageEventReplay(store([generated]), state, progress),
    generated,
  );
});

test("image replay scans fixed-size pages without retaining the run history", async () => {
  const events = Array.from({ length: 201 }, (_, i) =>
    lifecycle({
      ...incoming,
      sequence: i + 1,
      data: { ...incoming.data, itemId: `other-${i}` },
    }),
  );
  events.push(lifecycle({ ...incoming, sequence: 202 }));
  let pages = 0;
  const pageStore = store(events);
  const found = await findImageEventReplay(
    {
      listRunEvents: async (...args) => {
        pages += 1;
        assert.ok(args[2] <= 100);
        return pageStore.listRunEvents(...args);
      },
    },
    { ...state, lastSequence: 202 },
    incoming,
  );
  assert.equal(found?.sequence, 202);
  assert.equal(pages, 3);
  await assert.rejects(
    findImageEventReplay(store([]), state, incoming),
    (error) =>
      error instanceof ApplicationError &&
      error.code === "run_event_history_incomplete",
  );
});

function lifecycle(event: CanonicalAgentEvent): RunLifecycleEvent {
  return mapAgentEvent(
    event,
    event.sequence,
    `event-${event.sequence}`,
    "2026-09-14T00:00:00.000Z",
    () => "digest",
  );
}
function store(events: readonly RunLifecycleEvent[]) {
  return {
    listRunEvents: async (_query: unknown, after: number, limit: number) =>
      events.filter((event) => event.sequence > after).slice(0, limit),
  };
}
