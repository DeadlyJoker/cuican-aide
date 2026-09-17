import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  RuntimeCompositionLifetime,
  closeRuntimeResources,
} from "./runtime-composition-lifetime.ts";
import { deferred, until } from "./runtime-store-access.test-support.ts";

test("composition fences synchronously and repeated close joins ordered physical cleanup", async () => {
  const lifetime = new RuntimeCompositionLifetime(),
    stopped = deferred(),
    released = deferred();
  const events: string[] = [];
  lifetime.own(
    {
      close() {
        events.push("stop-a");
        return stopped.promise;
      },
    },
    { phase: "stop" },
  );
  lifetime.own(
    {
      close() {
        events.push("stop-b");
      },
    },
    { phase: "stop" },
  );
  lifetime.own(
    {
      close() {
        events.push("resources");
        return released.promise;
      },
    },
    { phase: "resources" },
  );
  lifetime.own(
    {
      close() {
        events.push("storage");
      },
    },
    { phase: "storage" },
  );
  const closing = lifetime.close();
  assert.equal(lifetime.close(), closing);
  assert.deepEqual(events, ["stop-a", "stop-b"]);
  assert.throws(
    () => lifetime.own({}, { phase: "resources" }),
    /runtime_composition_closed/,
  );
  stopped.resolve();
  await until(() => events.includes("resources"));
  assert.equal(events.includes("storage"), false);
  released.resolve();
  await closing;
  assert.deepEqual(events, ["stop-a", "stop-b", "resources", "storage"]);
  assert.equal(lifetime.close(), closing);
});

test("a synchronous close failure cannot skip siblings or later storage cleanup", async () => {
  const lifetime = new RuntimeCompositionLifetime(),
    held = deferred();
  const failure = new Error("stop failed"),
    events: string[] = [];
  lifetime.own(
    {
      close() {
        events.push("failed");
        throw failure;
      },
    },
    { phase: "stop" },
  );
  lifetime.own(
    {
      close() {
        events.push("held");
        return held.promise;
      },
    },
    { phase: "stop" },
  );
  lifetime.own(
    {
      close() {
        events.push("resources");
      },
    },
    { phase: "resources" },
  );
  lifetime.own(
    {
      close() {
        events.push("storage");
      },
    },
    { phase: "storage" },
  );
  const closing = lifetime.close();
  const checked = assert.rejects(
    closing,
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(events, ["failed", "held"]);
  held.resolve();
  await checked;
  assert.deepEqual(events, ["failed", "held", "resources", "storage"]);
  assert.equal(lifetime.close(), closing);
});

test("delegated input identities are closed once by the owning parent even on failure", async () => {
  const lifetime = new RuntimeCompositionLifetime(),
    failure = new Error("tool close failed");
  let toolCloses = 0,
    modelCloses = 0;
  const tool = {
    close() {
      toolCloses++;
      throw failure;
    },
  };
  const toolOwner = lifetime.own(tool, { phase: "resources" });
  assert.equal(lifetime.own(tool, { phase: "storage" }), toolOwner);
  const modelOwner = lifetime.own(
    {
      close() {
        modelCloses++;
      },
    },
    { phase: "resources" },
  );
  lifetime.own(
    { close: () => closeRuntimeResources([toolOwner, toolOwner, modelOwner]) },
    { phase: "stop" },
  );
  toolOwner.delegate();
  modelOwner.delegate();
  await assert.rejects(lifetime.close(), /runtime_close_failed/);
  await assert.rejects(toolOwner.close(), (error) => error === failure);
  assert.equal(toolCloses, 1);
  assert.equal(modelCloses, 1);
});

test("closed composition handles do not retain successfully disposed resources", async (t) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "./runtime-composition-lifetime-gc.test-support.ts",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 10000, maxBuffer: 4096 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    created: 128,
    collected: 128,
    retainedHandles: 128,
  });
  t.diagnostic(stdout.trim());
});
