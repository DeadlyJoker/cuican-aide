import assert from "node:assert/strict";
import test from "node:test";
import type { DomainStore } from "@crewon/application";
import { RuntimeStoreAccess } from "./runtime-store-access.ts";
import {
  deferred,
  storeAccessClock,
  until,
} from "./runtime-store-access.test-support.ts";

function access(clock = storeAccessClock()) {
  const failures: string[] = [];
  const owner = new RuntimeStoreAccess({
    leaseDurationMs: 30000,
    time: clock.time,
    onFailure: (e) => failures.push(e.code),
  });
  return { owner, clock, failures };
}

test("20,000 completed requests leave no deadline or physical admission behind", async () => {
  const { owner, clock } = access();
  const store = owner.store({
    loadRun: async () => null,
  } as unknown as DomainStore);
  for (let i = 0; i < 20000; i++) {
    assert.equal(owner.beginWake(), true);
    await store.loadRun({ tenantId: "t", runId: "r" });
  }
  assert.equal(clock.timers.size, 0);
  assert.equal(owner.snapshot().pendingRequests, 0);
  assert.equal(owner.snapshot().processRequests, 0);
  owner.beginClose();
  owner.close();
  await owner.whenClosed();
  assert.equal(clock.timers.size, 0);
});

test("timeout retains the physical request through 20,000 wakes and ignores late success", async () => {
  const { owner, clock, failures } = access();
  const held = deferred<null>();
  let calls = 0;
  const store = owner.store({
    loadRun: () => {
      calls++;
      return held.promise;
    },
  } as unknown as DomainStore);
  const request = store.loadRun({ tenantId: "t", runId: "r" });
  const rejected = assert.rejects(request, {
    code: "runtime_store_access_timeout",
  });
  clock.advance(10000);
  await rejected;
  for (let i = 0; i < 20000; i++) assert.equal(owner.beginWake(), false);
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
  assert.equal(owner.snapshot().pendingRequests, 1);
  assert.deepEqual(failures, ["runtime_store_access_timeout"]);
  held.resolve(null);
  await until(() => !owner.pending);
  assert.equal(owner.beginWake(), true);
  assert.equal(await store.loadRun({ tenantId: "t", runId: "r" }), null);
  assert.equal(owner.snapshot().processRequests, 0);
  owner.close();
});

for (const sleeping of [false, true])
  test(`late return cannot beat a delayed timer (sleep=${sleeping})`, async () => {
    const { owner, clock } = access();
    const held = deferred<null>();
    const store = owner.store({
      loadRun: () => held.promise,
    } as unknown as DomainStore);
    const rejected = assert.rejects(
      store.loadRun({ tenantId: "t", runId: "r" }),
      { code: "runtime_store_access_timeout" },
    );
    clock.advance(10000, false, sleeping);
    held.resolve(null);
    await rejected;
    assert.equal(owner.pending, false);
    assert.equal(clock.timers.size, 0);
    owner.close();
  });

test("close rejects waiters but releases capacity only on late failure", async () => {
  const { owner, clock } = access();
  const held = deferred<null>();
  const store = owner.store({
    loadRun: () => held.promise,
  } as unknown as DomainStore);
  const rejected = assert.rejects(
    store.loadRun({ tenantId: "t", runId: "r" }),
    { code: "runtime_worker_closing" },
  );
  owner.close();
  await rejected;
  assert.equal(owner.snapshot().pendingRequests, 1);
  assert.equal(owner.snapshot().processRequests, 1);
  assert.equal(clock.timers.size, 0);
  held.reject(new Error("database disconnected"));
  await until(() => !owner.pending);
  assert.equal(owner.snapshot().processRequests, 0);
  assert.equal(owner.beginWake(), false);
});

test("Store decorators preserve private receivers, optional ports and ordinary errors", async () => {
  const { owner } = access();
  const error = new Error("stale_lease");
  class Store {
    #value = "exact";
    compactionCheckpoints = { load: async () => this.#value };
    async loadRun() {
      return this.#value;
    }
    async completeWorkItem() {
      throw error;
    }
  }
  const original = new Store() as unknown as DomainStore;
  const store = owner.store(original);
  assert.equal(owner.store(original), store);
  assert.equal(await store.loadRun({ tenantId: "t", runId: "r" }), "exact");
  assert.equal(store.executionProgress, undefined);
  assert.equal(await store.compactionCheckpoints!.load({} as never), "exact");
  await assert.rejects(store.completeWorkItem({} as never), (e) => e === error);
  assert.equal(owner.failure(), null);
  owner.close();
});

test("graceful close permits settlement but repeated calls cannot extend its total deadline", async () => {
  const { owner, clock } = access();
  let writes = 0;
  const store = owner.store({
    completeWorkItem: async () => {
      writes++;
    },
  } as unknown as DomainStore);
  owner.beginClose();
  await store.completeWorkItem({} as never);
  clock.advance(9000);
  owner.beginClose();
  await store.completeWorkItem({} as never);
  clock.advance(1000, false, true);
  await assert.rejects(store.completeWorkItem({} as never), {
    code: "runtime_worker_closing",
  });
  await owner.whenClosed();
  assert.equal(writes, 2);
  assert.equal(clock.timers.size, 0);
  assert.equal(owner.beginWake(), false);
});

test("nested progress and compaction writes cannot bypass timeout or replay after close", async () => {
  for (const key of ["executionProgress", "compactionCheckpoints"] as const) {
    const { owner, clock } = access();
    const held = deferred();
    let calls = 0;
    const store = owner.store({
      [key]: {
        save: () => {
          calls++;
          return held.promise;
        },
      },
    } as unknown as DomainStore);
    const rejected = assert.rejects(store[key]!.save({} as never), {
      code: "runtime_store_access_timeout",
    });
    clock.advance(10000);
    await rejected;
    await assert.rejects(store[key]!.save({} as never), {
      code: "runtime_store_access_timeout",
    });
    assert.equal(calls, 1);
    owner.close();
    held.resolve();
    await until(() => !owner.pending);
  }
});

test("per-worker and process admission survive closure of all blocked owners", async () => {
  const owners: RuntimeStoreAccess[] = [];
  const held = deferred<null>();
  const results: Promise<unknown>[] = [];
  let calls = 0;
  const target = {
    loadRun: () => {
      calls++;
      return held.promise;
    },
  } as unknown as DomainStore;
  for (let worker = 0; worker < 4; worker++) {
    const { owner } = access();
    owners.push(owner);
    const store = owner.store(target);
    for (let i = 0; i < 32; i++)
      results.push(
        store.loadRun({ tenantId: "t", runId: "r" }).catch((e) => e.code),
      );
  }
  const last = access().owner;
  owners.push(last);
  await assert.rejects(
    last.store(target).loadRun({ tenantId: "t", runId: "r" }),
    { code: "runtime_store_access_capacity" },
  );
  await assert.rejects(
    owners[0]!.store(target).loadRun({ tenantId: "t", runId: "r" }),
    { code: "runtime_store_access_capacity" },
  );
  assert.equal(calls, 128);
  for (const owner of owners) owner.close();
  await Promise.all(results);
  assert.equal(last.snapshot().processRequests, 128);
  held.resolve(null);
  await until(() => last.snapshot().processRequests === 0);
});
