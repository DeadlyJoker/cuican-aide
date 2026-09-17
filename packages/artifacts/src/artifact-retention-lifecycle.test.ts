import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import type { ArtifactRetentionGuard } from "@crewon/application";
import { ArtifactRetentionQuery } from "./artifact-retention-query.ts";
import {
  recoveryFixture,
  recoveryInput,
} from "./artifact-write-recovery.test-support.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function expired() {
  const value = recoveryInput();
  return {
    ...value,
    record: {
      ...value.record,
      createdAt: "2020-01-01T00:00:00Z",
      retention: { kind: "run" as const, expiresAt: "2020-01-02T00:00:00Z" },
    },
  };
}

function stalled() {
  const entered = deferred<AbortSignal>();
  const physical = deferred<boolean>();
  let calls = 0;
  const guard: ArtifactRetentionGuard = {
    canRetireArtifact: async (_candidate, options) => {
      calls++;
      assert(options);
      entered.resolve(options.signal);
      return physical.promise;
    },
  };
  return { entered: entered.promise, physical, guard, calls: () => calls };
}

test("authority deadline detaches maintenance, retains physical admission across 1000 retries and ignores a late allow after close", async (t) => {
  const f = recoveryFixture(t),
    value = expired(),
    gate = stalled();
  await f.store.put(value);
  const keepAlive = setTimeout(() => {}, 3000);
  t.after(() => clearTimeout(keepAlive));
  const work = f.store.retention.maintainArtifacts({
    policy: { ...f.policy, maxDurationMs: 40 },
    guard: gate.guard,
    signal: new AbortController().signal,
  });
  const signal = await gate.entered;
  await assert.rejects(work, { code: "artifact_retention_guard_timeout" });
  assert(signal.aborted);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  for (let n = 0; n < 1000; n++) {
    const result = await f.maintain(f.store, gate.guard);
    assert.equal(result.disposition, "deferred");
    assert.equal(result.checked, 0);
  }
  assert.equal(gate.calls(), 1);
  assert.equal(f.store.retention.resourceSnapshot!().authorityQueries, 1);
  assert.equal(
    f.database.prepare("SELECT owner FROM artifact_maintenance").get()!.owner,
    null,
  );
  const before = performance.now();
  await f.store.close();
  assert(performance.now() - before < 500);
  assert.equal(f.store.retention.resourceSnapshot!().authorityQueries, 1);
  gate.physical.resolve(true);
  await turn();
  assert.equal(f.store.retention.resourceSnapshot!().authorityQueries, 0);
  assert(existsSync(f.blob(value)));
  assert.equal(
    f.database
      .prepare("SELECT retired_at_ms FROM artifact_retention_queue")
      .get()!.retired_at_ms,
    null,
  );
  const reopened = f.open();
  f.due();
  assert.equal(
    (await f.maintain(reopened, { canRetireArtifact: async () => true }))
      .deleted,
    1,
  );
});

test("cancellation closes a waiting authority observer before either a late success or rejection", async (t) => {
  for (const outcome of ["allow", "reject"] as const) {
    const f = recoveryFixture(t),
      value = expired(),
      gate = stalled();
    await f.store.put(value);
    const controller = new AbortController();
    const work = f.store.retention.maintainArtifacts({
      policy: f.policy,
      guard: gate.guard,
      signal: controller.signal,
    });
    const rejected = assert.rejects(work, /stop/);
    const signal = await gate.entered;
    controller.abort(new Error("stop"));
    await rejected;
    assert(signal.aborted);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await f.store.close();
    if (outcome === "allow") gate.physical.resolve(true);
    else gate.physical.reject(new Error("late private database failure"));
    await turn();
    assert(existsSync(f.blob(value)));
    assert.equal(f.store.retention.resourceSnapshot!().authorityQueries, 0);
  }
});

test("process admission includes reads from closed stores and admits new work only after actual settlement", async (t) => {
  const fixtures = Array.from({ length: 5 }, () => recoveryFixture(t));
  const gates = Array.from({ length: 4 }, () => stalled());
  const value = expired();
  for (const f of fixtures) await f.store.put(value);
  for (const [index, gate] of gates.entries()) {
    const f = fixtures[index]!;
    const work = f.maintain(f.store, gate.guard);
    const rejected = assert.rejects(work);
    await gate.entered;
    await f.store.close();
    await rejected;
  }
  const last = fixtures[4]!,
    snapshot = last.store.retention.resourceSnapshot!();
  assert.equal(snapshot.processAuthorityQueries, 4);
  assert.equal(snapshot.maxProcessAuthorityQueries, 4);
  let calls = 0;
  const guard = {
    canRetireArtifact: async () => {
      calls++;
      return true;
    },
  };
  for (let n = 0; n < 1000; n++)
    assert.equal(
      (await last.maintain(last.store, guard)).disposition,
      "deferred",
    );
  assert.equal(calls, 0);
  gates[0]!.physical.resolve(true);
  await turn();
  assert.equal((await last.maintain(last.store, guard)).deleted, 1);
  assert.equal(calls, 1);
  for (const gate of gates.slice(1)) gate.physical.resolve(false);
  await turn();
  assert.equal(
    last.store.retention.resourceSnapshot!().processAuthorityQueries,
    0,
  );
  for (const f of fixtures.slice(0, 4)) assert(existsSync(f.blob(value)));
});

test("completed, failed and cooperatively canceled reads release timers and listeners without changing admission", async (t) => {
  const query = new ArtifactRetentionQuery(),
    controller = new AbortController();
  const timers = new Set<NodeJS.Timeout>();
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof setTimeout>) => {
      const timer = originalSet(...args);
      timers.add(timer);
      return timer;
    },
  );
  t.mock.method(globalThis, "clearTimeout", (timer: NodeJS.Timeout) => {
    timers.delete(timer);
    originalClear(timer);
  });
  const candidate = expired();
  for (let n = 0; n < 1000; n++) {
    const fail = n % 2 === 0;
    const work = query.check({
      candidate,
      signal: controller.signal,
      maxDurationMs: 100,
      guard: {
        canRetireArtifact: () => {
          if (fail) throw new Error("guard_failure");
          return Promise.resolve(true);
        },
      },
    });
    if (fail) await assert.rejects(work, /guard_failure/);
    else assert.equal(await work, true);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(query.resourceSnapshot().authorityQueries, 0);
  }
  const gate = deferred<void>();
  const work = query.check({
    candidate,
    signal: controller.signal,
    maxDurationMs: 100,
    guard: {
      canRetireArtifact: async (_, options) =>
        new Promise((_, reject) => {
          options!.signal.addEventListener(
            "abort",
            () => reject(new Error("cooperative_abort")),
            { once: true },
          );
          gate.resolve();
        }),
    },
  });
  const rejected = assert.rejects(work);
  await gate.promise;
  query.close();
  await rejected;
  await turn();
  assert.equal(timers.size, 0);
  assert.equal(query.resourceSnapshot().processAuthorityQueries, 0);
});

test("abort before dispatch and exhausted duration do not invoke a guard or consume a physical slot", async () => {
  const query = new ArtifactRetentionQuery(),
    controller = new AbortController();
  let calls = 0;
  const options = {
    candidate: expired(),
    signal: controller.signal,
    maxDurationMs: 100,
    guard: {
      canRetireArtifact: async () => {
        calls++;
        return true;
      },
    },
  };
  await assert.rejects(query.check({ ...options, maxDurationMs: 0 }));
  const work = query.check(options);
  const rejected = assert.rejects(work);
  controller.abort();
  await rejected;
  await turn();
  assert.throws(() => query.check(options));
  assert.equal(calls, 0);
  assert.equal(query.resourceSnapshot().processAuthorityQueries, 0);
});

test("a detached uncooperative read does not retain its closed filesystem store after actual GC", async (t) => {
  const f = recoveryFixture(t),
    value = expired();
  await f.store.close();
  const moduleUrl = new URL("./filesystem-artifact-store.ts", import.meta.url)
    .href;
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { setImmediate as turn } from 'node:timers/promises';
    import { FilesystemArtifactStore } from ${JSON.stringify(moduleUrl)};
    const config = ${JSON.stringify({ rootDirectory: f.root, databasePath: f.databasePath, keyId: "key" })};
    const value = ${JSON.stringify({ record: value.record, idempotencyKey: value.idempotencyKey })};
    let release;
    const physical = new Promise(resolve => { release = resolve; });
    async function closeStore() {
      const store = new FilesystemArtifactStore({ ...config, encryptionKey: Buffer.alloc(32, 42) });
      await store.put({ ...value, content: Buffer.alloc(8192, 65) });
      let enter;
      const entered = new Promise(resolve => { enter = resolve; });
      const work = store.retention.maintainArtifacts({
        policy: ${JSON.stringify(f.policy)}, signal: new AbortController().signal,
        guard: { canRetireArtifact: () => { enter(); return physical; } },
      });
      const rejected = assert.rejects(work);
      await entered;
      await store.close();
      await rejected;
      assert.equal(store.retention.resourceSnapshot().authorityQueries, 1);
      return new WeakRef(store);
    }
    const weak = await closeStore();
    let collected = false;
    for (let n = 0; n < 30; n++) {
      await turn(); global.gc(); await turn();
      if (weak.deref() === undefined) { collected = true; break; }
    }
    assert(collected, 'pending physical read retained a closed filesystem store');
    release(true); await turn();
    console.log('closed_store_collected');
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /closed_store_collected/);
});
