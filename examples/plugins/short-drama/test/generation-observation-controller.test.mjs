import assert from "node:assert/strict";
import { after, test } from "node:test";
import { browser, settle } from "./ui.test-support.mjs";
import {
  actualController,
  clock,
  image,
  operation,
  reads,
  receipt,
  record,
  source,
  watch,
} from "./generation-observation.test-support.mjs";

const { ConceptGenerationController: Controller } = await actualController();
after(async () => browser.happyDOM.close());

test("an accepted original receipt follows stored queued, running and completed records without replacing the receipt", async (t) => {
  const time = clock(t);
  const fixture = reads(null);
  const controller = await watch(Controller, fixture, t);
  const queued = record();
  fixture.set(queued);
  controller.expectReceipt(source, receipt(queued));
  await settle();
  assert.equal(controller.getSnapshot().observation, "watching");
  assert.equal(controller.getSnapshot().generation.task.runStatus, "queued");
  const acceptedReadCount = fixture.calls.length;
  fixture.set(record(source, { runStatus: "running" }));
  await time.tick(1_999);
  assert.equal(fixture.calls.length, acceptedReadCount);
  await time.tick(1);
  assert.equal(controller.getSnapshot().generation.task.runStatus, "running");
  fixture.set(
    record(source, {
      runStatus: "completed",
      operations: [operation("succeeded", { images: [image], revision: 3 })],
    }),
  );
  await time.tick(2_000);
  assert.deepEqual(
    controller.getSnapshot().generation.task.operations[0].images,
    [image],
  );
  assert.equal(
    controller.getSnapshot().generation.task.runId,
    queued.task.runId,
  );
  assert.equal(controller.getSnapshot().observation, "idle");
  const completedReads = fixture.calls.length;
  await time.tick(120_000);
  assert.equal(fixture.calls.length, completedReads);
  assert.ok(fixture.calls.every((call) => !call.signal.aborted));
  assert.ok(
    fixture.calls.every(
      (call) => JSON.stringify(call.locator) === JSON.stringify(source),
    ),
  );
});

test("opening a stored active task resumes observation without a new generation receipt", async (t) => {
  const time = clock(t);
  const fixture = reads(record());
  const controller = await watch(Controller, fixture, t);
  assert.equal(controller.getSnapshot().observation, "watching");
  fixture.set(record(source, { runStatus: "completed" }));
  await time.tick(2_000);
  assert.equal(controller.getSnapshot().generation.task.runStatus, "completed");
  assert.equal(controller.getSnapshot().observation, "idle");
});

test("run completion alone does not stop a pending operation and background reads preserve visible results", async (t) => {
  const time = clock(t);
  const pending = record(source, {
    runStatus: "completed",
    operations: [operation("running")],
  });
  const fixture = reads(pending);
  const controller = await watch(Controller, fixture, t);
  const gate = fixture.hold();
  await time.tick(2_000);
  assert.equal(controller.getSnapshot().reading, true);
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.deepEqual(controller.getSnapshot().generation, pending);
  assert.equal(controller.getSnapshot().observation, "watching");
  const runningReads = fixture.calls.length;
  void controller.refresh();
  void controller.refresh();
  await settle();
  assert.equal(
    fixture.calls.length,
    runningReads,
    "manual refresh cannot overlap the current physical read",
  );
  gate.resolve({
    generation: record(source, {
      runStatus: "completed",
      operations: [operation("succeeded", { images: [image], revision: 3 })],
    }),
  });
  await settle();
  assert.equal(controller.getSnapshot().reading, false);
  assert.equal(controller.getSnapshot().observation, "idle");
});

for (const status of ["completed", "failed", "canceled"]) {
  test(`a fully terminal ${status} original task stops ordinary observation`, async (t) => {
    const time = clock(t);
    const fixture = reads(
      record(source, { runStatus: status, operations: [operation("failed")] }),
    );
    const controller = await watch(Controller, fixture, t);
    assert.equal(controller.getSnapshot().observation, "idle");
    await time.tick(120_000);
    assert.equal(fixture.calls.length, 1);
  });
}

test("unknown outcome, suspended runs and truncated terminal projections remain bounded observations", async (t) => {
  const time = clock(t);
  const cases = [
    record(source, {
      runStatus: "completed",
      operations: [operation("unknownOutcome")],
    }),
    ...["waitingApproval", "suspended", "reconciling"].map((runStatus) =>
      record(source, { runStatus }),
    ),
    record(source, {
      runStatus: "completed",
      operations: [operation("failed")],
      truncated: true,
    }),
  ];
  for (const pending of cases) {
    const fixture = reads(pending);
    const controller = await watch(Controller, fixture, t);
    await time.tick(2_000);
    assert.equal(fixture.calls.length, 2);
    assert.equal(controller.getSnapshot().observation, "watching");
    controller.dispose();
  }
});

test("source switch, readiness withdrawal and disposal abort in-flight reads and discard late successful images", async (t) => {
  const time = clock(t);
  for (const reason of ["source", "ready", "dispose"]) {
    const fixture = reads(record());
    const controller = await watch(Controller, fixture, t);
    const gate = fixture.hold();
    await time.tick(2_000);
    const pending = fixture.calls.at(-1);
    const next = { ...source, assetId: "different selected concept" };
    if (reason === "source") {
      fixture.set(
        record(next, { runId: "other-concept-run", runStatus: "completed" }),
      );
      controller.bind(next, true);
    } else if (reason === "ready") controller.bind(source, false);
    else controller.dispose();
    assert.equal(pending.signal.aborted, true, reason);
    gate.resolve({
      generation: record(source, {
        runStatus: "completed",
        operations: [operation("succeeded", { images: [image] })],
      }),
    });
    await settle();
    if (reason === "source") {
      assert.deepEqual(controller.getSnapshot().source, next);
      assert.equal(
        controller.getSnapshot().generation.task.runId,
        "other-concept-run",
      );
    } else if (reason === "ready")
      assert.equal(controller.getSnapshot().source, null);
    else
      assert.notEqual(
        controller.getSnapshot().generation?.task.operations[0]?.images[0]?.url,
        image.url,
      );
    const stopped = fixture.calls.length;
    await time.tick(120_000);
    assert.equal(fixture.calls.length, stopped, reason);
    controller.dispose();
  }
});

test("document hiding aborts the background read and reappearing preserves the original wall deadline", async (t) => {
  const time = clock(t);
  const fixture = reads(record());
  const controller = await watch(Controller, fixture, t);
  const gate = fixture.hold();
  await time.tick(2_000);
  controller.setVisible(false);
  assert.equal(fixture.calls.at(-1).signal.aborted, true);
  assert.equal(controller.getSnapshot().observation, "paused");
  gate.resolve({
    generation: record(source, {
      runStatus: "completed",
      operations: [operation("succeeded", { images: [image] })],
    }),
  });
  await settle();
  assert.equal(controller.getSnapshot().generation.task.runStatus, "queued");
  const hiddenReads = fixture.calls.length;
  await time.tick(118_000);
  assert.equal(fixture.calls.length, hiddenReads);
  controller.setVisible(true);
  await settle();
  assert.equal(controller.getSnapshot().observation, "exhausted");
  await time.tick(120_000);
  assert.equal(
    fixture.calls.length,
    hiddenReads,
    "showing the document does not renew the expired budget",
  );
});

test("a hidden fresh controller never starts automatic followup reads", async (t) => {
  const time = clock(t);
  const fixture = reads(record());
  const controller = new Controller(fixture.client);
  t.after(() => controller.dispose());
  controller.bind(source, true);
  await settle();
  const initialReads = fixture.calls.length;
  assert.equal(controller.getSnapshot().observation, "paused");
  await time.tick(20_000);
  assert.equal(fixture.calls.length, initialReads);
  controller.setVisible(true);
  await time.tick(2_000);
  assert.ok(fixture.calls.length > initialReads);
});

test("read failure clears obsolete results and stops automatically until an explicit refresh", async (t) => {
  const time = clock(t);
  const fixture = reads(record());
  const controller = await watch(Controller, fixture, t);
  const gate = fixture.hold();
  await time.tick(2_000);
  gate.reject(new Error("host_read_withdrawn"));
  await settle();
  assert.equal(controller.getSnapshot().phase, "unavailable");
  assert.equal(controller.getSnapshot().generation, null);
  assert.equal(controller.getSnapshot().reading, false);
  const failedReads = fixture.calls.length;
  await time.tick(120_000);
  assert.equal(fixture.calls.length, failedReads);
  await controller.refresh();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().observation, "watching");
});

test("a ten-second read timeout aborts once and cannot overlap an uncooperative physical read", async (t) => {
  const time = clock(t);
  const fixture = reads(record());
  const controller = await watch(Controller, fixture, t);
  const gate = fixture.hold();
  await time.tick(2_000);
  const pending = fixture.calls.at(-1);
  await time.tick(9_999);
  assert.equal(pending.signal.aborted, false);
  await time.tick(1);
  assert.equal(pending.signal.aborted, true);
  assert.equal(controller.getSnapshot().phase, "unavailable");
  assert.equal(controller.getSnapshot().generation, null);
  const timedOutReads = fixture.calls.length;
  void controller.refresh();
  await time.tick(120_000);
  assert.equal(fixture.calls.length, timedOutReads);
  gate.resolve({
    generation: record(source, {
      runStatus: "completed",
      operations: [operation("succeeded", { images: [image] })],
    }),
  });
  await settle();
  assert.equal(
    controller.getSnapshot().generation,
    null,
    "late timeout result never publishes success",
  );
});

test("ordinary bind and duplicate accepted receipt never renew the sixty-read, two-minute window", async (t) => {
  const time = clock(t);
  const generation = record();
  const fixture = reads(null);
  const controller = await watch(Controller, fixture, t);
  fixture.set(generation);
  const accepted = receipt(generation);
  controller.expectReceipt(source, accepted);
  await settle();
  const acceptedReadCount = fixture.calls.length;
  for (let tick = 0; tick < 60; tick++) {
    if (tick === 40) {
      controller.bind({ ...source }, true);
      controller.expectReceipt(
        { ...source },
        { ...accepted, disposition: "replayed" },
      );
    }
    await time.tick(2_000);
  }
  assert.ok(fixture.calls.length - acceptedReadCount <= 60);
  assert.ok(
    fixture.calls.length - acceptedReadCount >= 50,
    "exercise a continuing task through the finite read window",
  );
  assert.equal(controller.getSnapshot().observation, "exhausted");
  const exhausted = fixture.calls.length;
  controller.bind(source, true);
  controller.expectReceipt(source, accepted);
  await time.tick(120_000);
  assert.equal(fixture.calls.length, exhausted);
});

test("accepted independent query watches the original projection even if it is terminal, and duplicate query receipts do not restart", async (t) => {
  const time = clock(t);
  const generation = record(source, {
    runStatus: "completed",
    operations: [operation("succeeded", { images: [image] })],
  });
  const fixture = reads(generation);
  const controller = await watch(Controller, fixture, t);
  assert.equal(controller.getSnapshot().observation, "idle");
  const query = receipt(generation, "independent-query-run");
  controller.expectQueryReceipt(source, query);
  await settle();
  assert.equal(
    controller.getSnapshot().generation.task.runId,
    generation.task.runId,
  );
  assert.equal(controller.getSnapshot().observation, "watching");
  for (let tick = 0; tick < 60; tick++) {
    if (tick === 40)
      controller.expectQueryReceipt(source, {
        ...query,
        disposition: "replayed",
      });
    await time.tick(2_000);
  }
  assert.equal(controller.getSnapshot().observation, "exhausted");
  const exhaustedReads = fixture.calls.length;
  controller.expectQueryReceipt(source, query);
  await time.tick(20_000);
  assert.equal(fixture.calls.length, exhaustedReads);
  controller.expectQueryReceipt(
    source,
    receipt(generation, "second-independent-query-run"),
  );
  await settle();
  await time.tick(2_000);
  assert.ok(fixture.calls.length > exhaustedReads);
  assert.equal(
    controller.getSnapshot().generation.task.runId,
    generation.task.runId,
  );
});

test("accepted generation identity remains enforced on every followup read", async (t) => {
  const time = clock(t);
  const fixture = reads(null);
  const controller = await watch(Controller, fixture, t);
  const generation = record();
  fixture.set(generation);
  controller.expectReceipt(source, receipt(generation));
  await settle();
  fixture.set(record(source, { runId: "another-run", runStatus: "completed" }));
  await time.tick(2_000);
  assert.equal(controller.getSnapshot().phase, "unavailable");
  assert.equal(controller.getSnapshot().generation, null);
  const failedReads = fixture.calls.length;
  await time.tick(120_000);
  assert.equal(fixture.calls.length, failedReads);
});

test("a query receipt arriving before source restoration starts one finite window on the original terminal projection", async (t) => {
  const time = clock(t);
  const generation = record(source, {
    runStatus: "completed",
    operations: [operation("succeeded", { images: [image] })],
  });
  const fixture = reads(generation);
  const controller = new Controller(fixture.client);
  t.after(() => controller.dispose());
  controller.setVisible(true);
  const accepted = receipt(generation, "cold-restored-query-run");
  controller.expectQueryReceipt(source, accepted);
  assert.equal(fixture.calls.length, 0);
  controller.bind(source, true);
  await settle();
  assert.equal(controller.getSnapshot().observation, "watching");
  assert.equal(
    controller.getSnapshot().generation.task.runId,
    generation.task.runId,
  );
  const initialReads = fixture.calls.length;
  await time.tick(2_000);
  assert.equal(fixture.calls.length, initialReads + 1);
  for (let tick = 1; tick < 60; tick++) await time.tick(2_000);
  assert.equal(controller.getSnapshot().observation, "exhausted");
  const exhaustedReads = fixture.calls.length;
  controller.expectQueryReceipt(source, accepted);
  await time.tick(120_000);
  assert.equal(fixture.calls.length, exhaustedReads);
});

test("an accepted generation cancels a pre-acceptance read and then observes only the matching saved receipt record", async (t) => {
  const time = clock(t);
  const fixture = reads(null);
  const gate = fixture.hold();
  const controller = new Controller(fixture.client);
  t.after(() => controller.dispose());
  controller.setVisible(true);
  controller.bind(source, true);
  await settle();
  assert.equal(fixture.calls.length, 1);
  const preAcceptance = fixture.calls[0];
  const acceptedRecord = record();
  fixture.set(acceptedRecord);
  controller.expectReceipt(source, receipt(acceptedRecord));
  assert.equal(preAcceptance.signal.aborted, true);
  assert.equal(controller.getSnapshot().generation, null);
  assert.equal(
    fixture.calls.length,
    1,
    "an uncooperative pre-acceptance physical read must settle before another same-source read",
  );
  gate.resolve({ generation: null });
  await settle();
  assert.notEqual(
    controller.getSnapshot().phase,
    "unavailable",
    "the aborted pre-acceptance null record is not an authoritative mismatch",
  );
  await time.tick(2_000);
  assert.equal(
    controller.getSnapshot().generation.task.runId,
    acceptedRecord.task.runId,
  );
  assert.equal(controller.getSnapshot().observation, "watching");
  fixture.set(
    record(source, {
      runStatus: "completed",
      operations: [operation("succeeded", { images: [image] })],
    }),
  );
  await time.tick(2_000);
  assert.equal(
    controller.getSnapshot().generation.task.operations[0].images[0].url,
    image.url,
  );
  assert.equal(controller.getSnapshot().observation, "idle");
});
