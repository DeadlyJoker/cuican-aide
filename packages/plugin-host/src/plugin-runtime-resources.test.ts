import type { PluginAbortSignal } from "@crewon/plugin-sdk/node";
import assert from "node:assert/strict";
import test from "node:test";
import { PluginRuntimeResourceOwner } from "./plugin-runtime-resources.ts";

test("runtime resources dispose in reverse acquisition order and manual disposal is joined once", async () => {
  const owner = new PluginRuntimeResourceOwner(() => true);
  const calls: number[] = [];
  const one = await owner.api.acquire(() => ({
    value: 1,
    dispose: () => {
      calls.push(1);
    },
  }));
  await owner.api.acquire(() => ({
    value: 2,
    dispose: () => {
      calls.push(2);
    },
  }));
  await owner.api.acquire(() => ({
    value: 3,
    dispose: () => {
      calls.push(3);
    },
  }));
  await one.dispose();
  await one.dispose();
  await owner.close();
  await owner.close();
  assert.deepEqual(calls, [1, 3, 2]);
  await assert.rejects(
    owner.api.acquire(() => ({ value: 4, dispose() {} })),
    /plugin_resource_unavailable/,
  );
});

test("withdrawal aborts pending acquisition and joins late resource disposal before closing", async () => {
  const owner = new PluginRuntimeResourceOwner(() => true);
  let finish!: (resource: { value: number; dispose(): void }) => void;
  let signal!: PluginAbortSignal;
  let disposals = 0;
  const pending = owner.api.acquire((input) => {
    signal = input.signal;
    return new Promise<{ value: number; dispose(): void }>((resolve) => {
      finish = resolve;
    });
  });
  const rejected = assert.rejects(pending, /plugin_resource_withdrawn/);
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  finish({
    value: 1,
    dispose() {
      disposals++;
    },
  });
  await rejected;
  await closing;
  assert.equal(disposals, 1);
});

test("failed disposal remains an observable cleanup failure without repeating side effects", async () => {
  const owner = new PluginRuntimeResourceOwner(() => true);
  let calls = 0;
  const resource = await owner.api.acquire(() => ({
    value: 1,
    dispose() {
      calls++;
      throw new Error("close-failed");
    },
  }));
  await assert.rejects(Promise.resolve(resource.dispose()), /close-failed/);
  await assert.rejects(owner.close(), /plugin_resource_cleanup_failed/);
  await assert.rejects(owner.close(), /plugin_resource_cleanup_failed/);
  assert.equal(calls, 1);
});

test("resource ownership is bounded and a released slot may be reused", async () => {
  const owner = new PluginRuntimeResourceOwner(() => true);
  const first = await owner.api.acquire(() => ({ value: 0, dispose() {} }));
  for (let i = 1; i < 512; i++)
    await owner.api.acquire(() => ({ value: i, dispose() {} }));
  await assert.rejects(
    owner.api.acquire(() => ({ value: 512, dispose() {} })),
    /plugin_resource_limit/,
  );
  await first.dispose();
  await owner.api.acquire(() => ({ value: 513, dispose() {} }));
  await owner.close();
});

test("failure to acquire does not invent a resource or prevent cleanup", async () => {
  const owner = new PluginRuntimeResourceOwner(() => true);
  await assert.rejects(
    owner.api.acquire(() => {
      throw new Error("acquisition-failed");
    }),
    /acquisition-failed/,
  );
  await owner.close();
});

test("concurrent acquisition retains registration order even when completion order differs", async () => {
  const owner = new PluginRuntimeResourceOwner(() => true);
  assert.equal(owner.api.apiVersion, "1");
  const disposed: number[] = [];
  let finish!: (resource: { value: number; dispose(): void }) => void;
  const first = owner.api.acquire(
    () =>
      new Promise<{ value: number; dispose(): void }>((resolve) => {
        finish = resolve;
      }),
  );
  await owner.api.acquire(() => ({
    value: 2,
    dispose() {
      disposed.push(2);
    },
  }));
  finish({
    value: 1,
    dispose() {
      disposed.push(1);
    },
  });
  await first;
  await owner.close();
  assert.deepEqual(disposed, [2, 1]);
});
