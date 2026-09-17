import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionReceiptState } from "@crewon/domain";
import type { DomainStore } from "@crewon/application";
import {
  InMemoryToolBroker,
  ToolResultCapacity,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";
import {
  command,
  definition,
  policy,
  committedResult,
} from "../../../packages/tool-broker/src/tool-execution.test-support.ts";
import { ToolResultMaintenance } from "./tool-result-maintenance.ts";

const owner = { resultOwner: { tenantId: "tenant-1" } };
function fixture() {
  const capacity = new ToolResultCapacity();
  const runtime = new InMemoryToolBroker(
    [definition("fixture")],
    new Map([["function:fixture", async () => ({ output: "result" })]]),
    new Map([["function:fixture", policy("readOnly", "replaySafe")]]),
    { resultCapacity: capacity },
  );
  const commands: ToolExecutionCommand[] = [];
  const receipts = new Map<string, ToolExecutionReceiptState>();
  const queries: string[] = [];
  const store: Pick<DomainStore, "loadToolExecutionReceiptByAction"> = {
    async loadToolExecutionReceiptByAction(query) {
      queries.push(query.actionDigest);
      return receipts.get(query.actionDigest) ?? null;
    },
  };
  const maintenance = new ToolResultMaintenance({
    store,
    nextRuntime: () => runtime,
  });
  const add = async (number: number) => {
    const input = command({
      name: "fixture",
      runId: `run-${number}`,
      executionId: `execution-${number}`,
      idempotencyKey: `key-${number}`,
      callId: `call-${number}`,
    });
    const result = await runtime
      .reserveExecution(input, new AbortController().signal, owner)
      .execute();
    commands.push(input);
    // The Store double only supplies the receipt fields used by ownership verification.
    const receipt = {
      ...input,
      tenantId: "tenant-1",
      call: { kind: input.kind, name: input.name, callId: input.callId },
      status: "completed",
      providerReceiptId: result.providerReceiptId,
    } as unknown as ToolExecutionReceiptState;
    receipts.set(input.actionDigest, receipt);
    return input;
  };
  const close = () => {
    maintenance.close();
    for (const input of commands)
      runtime.acknowledgeExecutionResult(
        committedResult(input, `in-memory:${input.executionId}`),
      );
  };
  return {
    runtime,
    capacity,
    receipts,
    queries,
    store,
    maintenance,
    add,
    close,
  };
}

for (const mutation of [
  "missing",
  "uncommitted",
  "unknown",
  "foreignTenant",
  "foreignRun",
  "foreignDigest",
  "legacy",
] as const) {
  test(`maintenance retains ${mutation} evidence while a later matching result is released`, async (t) => {
    const f = fixture();
    t.after(f.close);
    const first = await f.add(1);
    await f.add(2);
    const receipt = f.receipts.get(first.actionDigest)!;
    if (mutation === "missing") f.receipts.delete(first.actionDigest);
    else
      f.receipts.set(first.actionDigest, {
        ...receipt,
        ...(mutation === "uncommitted" ? { status: "dispatched" } : {}),
        ...(mutation === "unknown" ? { status: "unknownOutcome" } : {}),
        ...(mutation === "foreignTenant" ? { tenantId: "other" } : {}),
        ...(mutation === "foreignRun" ? { runId: "other" } : {}),
        ...(mutation === "foreignDigest" ? { actionDigest: "other" } : {}),
        ...(mutation === "legacy" ? { actionIntent: null } : {}),
      });
    const snapshot = await f.maintenance.poll();
    assert.equal(snapshot.acknowledged, 1);
    assert.equal(f.capacity.resourceSnapshot().executionCount, 1);
    assert.equal(
      f.runtime.readRetainedExecutionResult(first)?.status,
      "completed",
    );
    assert.ok(
      f.queries.length <= 2,
      "unresolved evidence is queried at most once per pass",
    );
  });
}

test("maintenance isolates lookup/ACK failures and keeps a fixed per-pass query budget", async (t) => {
  const f = fixture();
  t.after(f.close);
  for (let n = 0; n < 40; n++) await f.add(n);
  const read = f.store.loadToolExecutionReceiptByAction;
  let calls = 0;
  f.store.loadToolExecutionReceiptByAction = async (query) => {
    if (++calls === 1) throw new Error("temporarily unavailable");
    return read(query);
  };
  const ack = f.runtime.acknowledgeExecutionResult.bind(f.runtime);
  let acknowledgements = 0;
  f.runtime.acknowledgeExecutionResult = (value) => {
    if (++acknowledgements === 1) throw new Error("ACK interrupted");
    return ack(value);
  };
  const first = await f.maintenance.poll();
  assert.ok(calls <= 16);
  assert.equal(first.failures, 2);
  assert.ok(first.acknowledged > 0);
  for (
    let pass = 0;
    pass < 10 && f.capacity.resourceSnapshot().executionCount;
    pass++
  )
    await f.maintenance.poll();
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
});

test("a stalled query has one physical owner across repeated wakes and does not starve the next result after recovery", async (t) => {
  const f = fixture();
  t.after(f.close);
  const first = await f.add(1),
    second = await f.add(2);
  let resolve!: (receipt: ToolExecutionReceiptState) => void;
  const pending = new Promise<ToolExecutionReceiptState>((done) => {
    resolve = done;
  });
  const read = f.store.loadToolExecutionReceiptByAction;
  let calls = 0;
  f.store.loadToolExecutionReceiptByAction = async (query) =>
    ++calls === 1 ? pending : read(query);
  assert.equal((await f.maintenance.poll()).pending, true);
  for (let n = 0; n < 20_000; n++)
    assert.equal((await f.maintenance.poll()).pending, true);
  assert.equal(calls, 1);
  assert.equal(f.capacity.resourceSnapshot().executionCount, 2);
  resolve(f.receipts.get(first.actionDigest)!);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.capacity.resourceSnapshot().executionCount, 1);
  await f.maintenance.poll();
  assert.equal(f.runtime.readRetainedExecutionResult(second), null);
  assert.equal(f.capacity.resourceSnapshot().reservedBytes, 0);
});

test("shutdown prevents late acknowledgement and starts no new Store reads", async (t) => {
  const f = fixture();
  t.after(f.close);
  const input = await f.add(1);
  let resolve!: (receipt: ToolExecutionReceiptState) => void,
    calls = 0;
  f.store.loadToolExecutionReceiptByAction = () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  assert.equal((await f.maintenance.poll()).pending, true);
  f.maintenance.close();
  resolve(f.receipts.get(input.actionDigest)!);
  await new Promise<void>((done) => setImmediate(done));
  await f.maintenance.poll();
  assert.equal(calls, 1);
  assert.equal(f.capacity.resourceSnapshot().executionCount, 1);
});

test("closed workers keep stalled receipt reads within a shared process limit", async (t) => {
  const fixtures = Array.from({ length: 12 }, fixture);
  const releases: (() => void)[] = [];
  let calls = 0;
  t.after(async () => {
    for (const f of fixtures) f.close();
    for (const release of releases) release();
    await new Promise<void>((done) => setImmediate(done));
  });
  for (const [index, f] of fixtures.entries()) {
    const input = await f.add(index);
    f.store.loadToolExecutionReceiptByAction = () => {
      calls++;
      return new Promise((resolve) => {
        releases.push(() => resolve(f.receipts.get(input.actionDigest)!));
      });
    };
    await f.maintenance.poll();
    f.maintenance.close();
  }
  assert.equal(calls, 4, "closed queries must still occupy process admission");
  for (const f of fixtures)
    assert.equal(f.capacity.resourceSnapshot().executionCount, 1);
});
