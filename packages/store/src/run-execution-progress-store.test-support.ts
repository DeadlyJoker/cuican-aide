import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  DomainStore,
  SaveRunExecutionProgressInput,
} from "@crewon/application";

export function registerRunExecutionProgressConformance(
  name: string,
  fixture: (context: TestContext) => Promise<{
    store: DomainStore;
    input: SaveRunExecutionProgressInput;
    expire(): Promise<void>;
    cancel(): Promise<void>;
  }>,
) {
  test(`${name}: execution progress persists a source-bound checkpoint and replays without changing Run events`, async (context) => {
    const f = await fixture(context);
    const port = f.store.executionProgress!;
    const before = await f.store.listRunEvents(f.input.scope, 0, 100);
    assert.equal(await port.load(f.input), null);
    await port.save(f.input);
    assert.deepEqual(await port.load(f.input), f.input.checkpoint);
    await port.save(f.input);
    assert.deepEqual(
      await f.store.listRunEvents(f.input.scope, 0, 100),
      before,
    );
    await assert.rejects(
      port.save({
        ...f.input,
        checkpoint: { ...f.input.checkpoint, payload: "different" },
      }),
      { code: "run_execution_progress_cursor_conflict" },
    );
    assert.deepEqual(await port.load(f.input), f.input.checkpoint);
  });
  test(`${name}: execution progress rejects forged, future and oversized sources before persisting`, async (context) => {
    const f = await fixture(context);
    const port = f.store.executionProgress!;
    for (const value of [
      { ...f.input, scope: { ...f.input.scope, tenantId: "foreign" } },
      {
        ...f.input,
        checkpoint: { ...f.input.checkpoint, sourceEventId: "foreign-event" },
      },
      {
        ...f.input,
        checkpoint: {
          ...f.input.checkpoint,
          throughSequence: f.input.checkpoint.throughSequence + 1,
        },
      },
      {
        ...f.input,
        checkpoint: { ...f.input.checkpoint, payload: "界".repeat(100000) },
      },
      { ...f.input, expectedThroughSequence: 1 },
    ])
      await assert.rejects(port.save(value));
    assert.equal(await port.load(f.input), null);
    await port.save(f.input);
  });
  test(`${name}: cancellation progress access and reset require an actual cancel request and preserve source events`, async (context) => {
    const f = await fixture(context);
    const port = f.store.executionProgress!;
    await port.save(f.input);
    await assert.rejects(port.load({ ...f.input, purpose: "cancel" }));
    await assert.rejects(port.resetForCancellation!(f.input));
    await assert.rejects(
      port.resetForCancellation!({ ...f.input, purpose: "cancel" }),
    );
    assert.deepEqual(await port.load(f.input), f.input.checkpoint);
    await f.cancel();
    const cancel = { ...f.input, purpose: "cancel" as const };
    const events = await f.store.listRunEvents(f.input.scope, 0, 100);
    await assert.rejects(port.load(f.input));
    await assert.rejects(port.save(f.input));
    assert.deepEqual(await port.load(cancel), f.input.checkpoint);
    await port.resetForCancellation!(cancel);
    assert.equal(await port.load(cancel), null);
    await port.resetForCancellation!(cancel);
    await port.save(cancel);
    assert.deepEqual(await port.load(cancel), f.input.checkpoint);
    assert.deepEqual(
      await f.store.listRunEvents(f.input.scope, 0, 100),
      events,
    );
  });
  test(`${name}: an expired cancellation lease cannot read, erase or replace derived progress`, async (context) => {
    const f = await fixture(context);
    const port = f.store.executionProgress!;
    await port.save(f.input);
    await f.cancel();
    await f.expire();
    const input = { ...f.input, purpose: "cancel" as const };
    await assert.rejects(port.load(input));
    await assert.rejects(port.resetForCancellation!(input));
    await assert.rejects(port.save(input));
  });
  test(`${name}: expired execution progress leases cannot read, replay or replace the checkpoint`, async (context) => {
    const f = await fixture(context);
    const port = f.store.executionProgress!;
    await port.save(f.input);
    await f.expire();
    await assert.rejects(port.load(f.input));
    await assert.rejects(port.save(f.input));
  });
}
