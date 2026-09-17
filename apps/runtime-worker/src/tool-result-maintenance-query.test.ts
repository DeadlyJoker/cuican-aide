import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setImmediate as turn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { DomainStore } from "@crewon/application";
import type { ToolExecutionReceiptState } from "@crewon/domain";
import { ToolResultMaintenanceQuery } from "./tool-result-maintenance-query.ts";

const query = { tenantId: "tenant-1", runId: "run-1", actionDigest: "digest" };

test("closing before dispatch releases the observer without reading the Store", async () => {
  const owner = new ToolResultMaintenanceQuery();
  let reads = 0;
  const work = owner.read({
    query,
    store: {
      async loadToolExecutionReceiptByAction() {
        reads++;
        return null;
      },
    },
  });
  assert.equal(owner.snapshot().processReceiptReads, 1);
  owner.close();
  assert.equal(await work, null);
  await turn();
  assert.equal(reads, 0);
  assert.equal(owner.snapshot().processReceiptReads, 0);
  assert.equal(owner.available, false);
});

test("detached reads retain admission until late success or failure physically settles", async (t) => {
  const owners = Array.from(
    { length: 4 },
    () => new ToolResultMaintenanceQuery(),
  );
  const settles: ((fail: boolean) => void)[] = [];
  let reads = 0;
  const store: Pick<DomainStore, "loadToolExecutionReceiptByAction"> = {
    loadToolExecutionReceiptByAction(actual) {
      assert.deepEqual(actual, query);
      reads++;
      return new Promise<ToolExecutionReceiptState | null>(
        (resolve, reject) => {
          settles.push((fail) =>
            fail ? reject(new Error("late failure")) : resolve(null),
          );
        },
      );
    },
  };
  t.after(async () => {
    owners.forEach((owner) => owner.close());
    settles.forEach((settle) => settle(false));
    await turn();
  });
  const work = owners.map((owner) => owner.read({ store, query }));
  await turn();
  owners.forEach((owner) => owner.close());
  assert.deepEqual(await Promise.all(work), [null, null, null, null]);
  const next = new ToolResultMaintenanceQuery();
  t.after(() => next.close());
  for (let n = 0; n < 1000; n++) {
    const reopened = new ToolResultMaintenanceQuery();
    assert.equal(reopened.available, false);
    assert.equal(await reopened.read({ store, query }), null);
    reopened.close();
  }
  assert.equal(reads, 4);
  assert.equal(next.snapshot().processReceiptReads, 4);
  settles[0](true);
  await turn();
  assert.equal(next.snapshot().processReceiptReads, 3);
  assert.equal(next.available, true);
  const restarted = next.read({ store, query });
  await turn();
  assert.equal(reads, 5);
  assert.equal(next.snapshot().processReceiptReads, 4);
  settles[4](false);
  assert.equal(await restarted, null);
  for (const settle of settles.slice(1, 4)) settle(false);
  await turn();
  assert.equal(next.snapshot().processReceiptReads, 0);
});

test("successful, rejected and synchronously throwing receipt reads all return their admission", async (t) => {
  const owner = new ToolResultMaintenanceQuery();
  t.after(() => owner.close());
  for (let n = 0; n < 1000; n++) {
    const work = owner.read({
      query,
      store: {
        loadToolExecutionReceiptByAction(actual) {
          assert.deepEqual(actual, query);
          if (n % 3 === 0) throw new Error("sync failure");
          if (n % 3 === 1) return Promise.reject(new Error("async failure"));
          return Promise.resolve(null);
        },
      },
    });
    if (n % 3 !== 2) await assert.rejects(work, /failure/);
    else assert.equal(await work, null);
    assert.equal(owner.snapshot().receiptReads, 0);
    assert.equal(owner.snapshot().processReceiptReads, 0);
    assert.equal(owner.available, true);
  }
});

test("an uncooperative receipt read does not retain a closed RuntimeWorker or its Store after actual GC", async (t) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "./tool-result-maintenance-gc.test-support.ts",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 10_000, maxBuffer: 32_768 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.workerCollected, true);
  assert.equal(result.storeCollected, true);
  assert.equal(result.retainedBeforeAck, 1);
  assert.equal(result.retainedAfterAck, 0);
  t.diagnostic(JSON.stringify(result));
});
