import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRunStore } from "@crewon/store";

import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { RunEventHub } from "./run-event-hub.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("20,000 commit hints retain only one follow-up when an empty physical claim is pending", async (context) => {
  const store = new InMemoryRunStore();
  const hub = new RunEventHub();
  const owner = new OutboxDispatcher(
    { store, eventHub: hub },
    {
      ownerId: "hint-owner",
      nextLeaseId: () => "hint-lease",
      scanIntervalMs: null,
      retention: null,
    },
  );
  let release!: (value: null) => void;
  const pending = new Promise<null>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  context.mock.method(store, "claimNextOutbox", () =>
    ++calls === 1 ? pending : Promise.resolve(null),
  );
  context.after(async () => {
    release(null);
    await owner.close();
    hub.close();
    await store.close();
  });
  const original = owner.wake();
  for (let index = 0; index < 20_000; index++) owner.notifyAvailability();
  assert.equal(calls, 1);
  release(null);
  await original;
  assert.equal(calls, 1);
  await tick();
  assert.equal(calls, 2);
  await tick();
  assert.equal(calls, 2);
});

test("an idle burst gets one prompt drain and no unbounded per-hint promise callbacks", async (context) => {
  const store = new InMemoryRunStore();
  const hub = new RunEventHub();
  const owner = new OutboxDispatcher(
    { store, eventHub: hub },
    {
      ownerId: "hint-owner",
      nextLeaseId: () => "hint-lease",
      scanIntervalMs: 60_000,
      retention: null,
    },
  );
  let calls = 0;
  context.mock.method(store, "claimNextOutbox", async () => {
    calls++;
    return null;
  });
  context.after(async () => {
    await owner.close();
    hub.close();
    await store.close();
  });
  for (let index = 0; index < 20_000; index++) owner.notifyAvailability();
  assert.equal(calls, 0);
  await tick();
  assert.equal(calls, 1);
  await tick();
  assert.equal(calls, 1);
});

test("close cancels queued hint delivery and ignores later commit hints", async (context) => {
  const store = new InMemoryRunStore();
  const hub = new RunEventHub();
  const owner = new OutboxDispatcher(
    { store, eventHub: hub },
    {
      ownerId: "hint-owner",
      nextLeaseId: () => "hint-lease",
      scanIntervalMs: null,
      retention: null,
    },
  );
  let calls = 0;
  context.mock.method(store, "claimNextOutbox", async () => {
    calls++;
    return null;
  });
  context.after(async () => {
    await owner.close();
    hub.close();
    await store.close();
  });
  owner.notifyAvailability();
  await owner.close();
  for (let index = 0; index < 20_000; index++) owner.notifyAvailability();
  await tick();
  assert.equal(calls, 0);
});

test("a late physical claim cannot schedule the dirty follow-up after close", async (context) => {
  const store = new InMemoryRunStore();
  const hub = new RunEventHub();
  const owner = new OutboxDispatcher(
    { store, eventHub: hub },
    {
      ownerId: "hint-owner",
      nextLeaseId: () => "hint-lease",
      scanIntervalMs: null,
      retention: null,
    },
  );
  let release!: (value: null) => void;
  const pending = new Promise<null>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  context.mock.method(store, "claimNextOutbox", () => {
    calls++;
    return pending;
  });
  context.after(async () => {
    release(null);
    await owner.close();
    hub.close();
    await store.close();
  });
  const drain = owner.wake();
  owner.notifyAvailability();
  const closing = owner.close();
  release(null);
  await drain;
  await closing;
  await tick();
  assert.equal(calls, 1);
});

test("admission exhaustion coalesces hints and slot release wakes the owner without another scan", async (context) => {
  const owners = Array.from({ length: 5 }, (_, index) => {
    const store = new InMemoryRunStore();
    const hub = new RunEventHub();
    const owner = new OutboxDispatcher(
      { store, eventHub: hub },
      {
        ownerId: `hint-owner-${index}`,
        nextLeaseId: () => `hint-lease-${index}`,
        scanIntervalMs: 1000,
        retention: null,
      },
    );
    let release!: (value: null) => void;
    const pending = new Promise<null>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    context.mock.method(store, "claimNextOutbox", () =>
      ++calls === 1 && index < 4 ? pending : Promise.resolve(null),
    );
    return { store, hub, owner, release, calls: () => calls };
  });
  context.after(async () => {
    for (const current of owners) current.release(null);
    for (const current of owners) {
      await current.owner.close();
      current.hub.close();
      await current.store.close();
    }
  });
  for (const current of owners.slice(0, 4)) void current.owner.wake();
  const last = owners[4]!;
  for (let index = 0; index < 20_000; index++) last.owner.notifyAvailability();
  await tick();
  assert.equal(last.calls(), 0);
  assert.equal(last.owner.deliveryStatus().admissionDeferred, true);
  owners[0]!.release(null);
  await owners[0]!.owner.wake();
  await tick();
  assert.equal(last.calls(), 1);
  assert.equal(last.owner.deliveryStatus().admissionDeferred, false);
});

test("a hinted replacement waits for the closed Store owner's physical query then resumes immediately", async (context) => {
  const store = new InMemoryRunStore();
  const hub = new RunEventHub();
  const first = new OutboxDispatcher(
    { store, eventHub: hub },
    {
      ownerId: "old-owner",
      nextLeaseId: () => "old-lease",
      scanIntervalMs: null,
      retention: null,
    },
  );
  const replacement = new OutboxDispatcher(
    { store, eventHub: hub },
    {
      ownerId: "new-owner",
      nextLeaseId: () => "new-lease",
      scanIntervalMs: null,
      retention: null,
    },
  );
  let release!: (value: null) => void;
  const pending = new Promise<null>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  context.mock.method(store, "claimNextOutbox", () =>
    ++calls === 1 ? pending : Promise.resolve(null),
  );
  context.after(async () => {
    release(null);
    await first.close();
    await replacement.close();
    hub.close();
    await store.close();
  });
  const drain = first.wake();
  await first.close();
  for (let index = 0; index < 20_000; index++) replacement.notifyAvailability();
  await tick();
  assert.equal(calls, 1);
  assert.equal(first.deliveryStatus().inFlight, true);
  assert.equal(replacement.deliveryStatus().admissionDeferred, true);
  release(null);
  await drain;
  await tick();
  assert.equal(calls, 2);
  await tick();
  assert.equal(calls, 2);
});

test("a closed waiting owner is removed and a physically busy Store does not block an eligible Store", async (context) => {
  const stores = Array.from({ length: 5 }, () => new InMemoryRunStore());
  const hub = new RunEventHub();
  const make = (store: InMemoryRunStore, id: string) =>
    new OutboxDispatcher(
      { store, eventHub: hub },
      {
        ownerId: id,
        nextLeaseId: () => id,
        scanIntervalMs: null,
        retention: null,
      },
    );
  const holders = stores
    .slice(0, 4)
    .map((store, index) => make(store, `holder-${index}`));
  const blocked = make(stores[0]!, "blocked-same-store");
  const retired = make(stores[4]!, "retired-waiter");
  const eligible = make(stores[4]!, "eligible-waiter");
  const releases: Array<(value: null) => void> = [];
  const drains: Promise<void>[] = [];
  let availableCalls = 0;
  for (const store of stores.slice(0, 4)) {
    const pending = new Promise<null>((resolve) => {
      releases.push(resolve);
    });
    context.mock.method(store, "claimNextOutbox", () => pending);
  }
  context.mock.method(stores[4]!, "claimNextOutbox", async () => {
    availableCalls++;
    return null;
  });
  context.after(async () => {
    for (const release of releases) release(null);
    for (const owner of [...holders, blocked, retired, eligible])
      await owner.close();
    hub.close();
    for (const store of stores) await store.close();
  });
  for (const owner of holders) drains.push(owner.wake());
  blocked.notifyAvailability();
  retired.notifyAvailability();
  eligible.notifyAvailability();
  await tick();
  assert.equal(availableCalls, 0);
  await retired.close();
  releases[1]!(null);
  await drains[1];
  await tick();
  assert.equal(availableCalls, 1);
  assert.equal(blocked.deliveryStatus().admissionDeferred, true);
  assert.equal(retired.deliveryStatus().closed, true);
  assert.equal(eligible.deliveryStatus().admissionDeferred, false);
});
