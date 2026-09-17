import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { StorageAdmissionError } from "@crewon/application";
import {
  FilesystemStorageAdmission,
  createLocalStorageAdmissionOwner,
} from "./filesystem-storage-admission.ts";

const policy = {
  minimumAvailableBytes: 100n,
  recoveryAvailableBytes: 200n,
  snapshotMaxAgeMs: 10,
  probeTimeoutMs: 50,
  retryAfterMs: 1_000,
};
const paths = ["/first", "/second"];

test("shares a probe across 1,000 concurrent admissions and keeps no timeout handles after completion", async () => {
  let reads = 0;
  let finish!: (value: readonly bigint[]) => void;
  const read = new Promise<readonly bigint[]>((resolve) => {
    finish = resolve;
  });
  const beforeTimers = process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
  const gate = new FilesystemStorageAdmission(
    { paths, policy },
    {
      readAvailableBytes: async () => {
        reads++;
        return read;
      },
      monotonicNow: () => 0,
    },
  );
  const requests = Array.from({ length: 1_000 }, () =>
    gate.assertNewWorkAllowed(),
  );
  await Promise.resolve();
  assert.equal(reads, 1);
  finish([150n, 500n]);
  await Promise.all(requests);
  await Promise.all(
    Array.from({ length: 1_000 }, () => gate.assertNewWorkAllowed()),
  );
  assert.equal(reads, 1);
  assert.deepEqual(gate.snapshot(), { state: "healthy", availableBytes: 150n });
  gate.close();
  assert.equal(
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length,
    beforeTimers,
  );
});

test("checks the least available filesystem and requires a higher recovery watermark", async () => {
  let now = 0;
  let available = 150n;
  const gate = new FilesystemStorageAdmission(
    { paths, policy },
    {
      readAvailableBytes: async () => [500n, available],
      monotonicNow: () => now,
    },
  );
  await gate.assertNewWorkAllowed();
  for (const value of [99n, 100n, 199n]) {
    available = value;
    now += 11;
    await assert.rejects(
      gate.assertNewWorkAllowed(),
      hasCode("storage_capacity_low"),
    );
    assert.equal(gate.snapshot().availableBytes, value);
  }
  available = 200n;
  now += 11;
  await gate.assertNewWorkAllowed();
  available = 100n;
  now += 11;
  await gate.assertNewWorkAllowed();
  gate.close();
});

test("a timed-out native probe keeps its slot until it settles and cannot later authorize stale capacity", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  let reads = 0;
  let finish!: (value: readonly bigint[]) => void;
  const pending = new Promise<readonly bigint[]>((resolve) => {
    finish = resolve;
  });
  const gate = new FilesystemStorageAdmission(
    { paths, policy },
    {
      readAvailableBytes: async () => (++reads === 1 ? pending : [500n, 500n]),
      monotonicNow: () => now,
    },
  );
  const rejected = assert.rejects(
    gate.assertNewWorkAllowed(),
    hasCode("storage_capacity_unknown"),
  );
  await Promise.resolve();
  now = 50;
  context.mock.timers.tick(50);
  await rejected;
  now = 100;
  await Promise.all(
    Array.from({ length: 1_000 }, () =>
      assert.rejects(
        gate.assertNewWorkAllowed(),
        hasCode("storage_capacity_unknown"),
      ),
    ),
  );
  assert.equal(reads, 1);
  finish([500n, 500n]);
  await setImmediate();
  assert.equal(gate.snapshot().state, "unknown");
  await gate.assertNewWorkAllowed();
  assert.equal(reads, 2);
  gate.close();
});

test("invalid or failed observations fail closed without exposing paths or native errors", async () => {
  let now = 0;
  let value: readonly bigint[] | Error = new Error(
    "private/path: native failure",
  );
  const gate = new FilesystemStorageAdmission(
    { paths, policy },
    {
      readAvailableBytes: async () => {
        if (value instanceof Error) throw value;
        return value;
      },
      monotonicNow: () => now,
    },
  );
  for (const sample of [value, [], [1000n, -1n], [1000n, 1000n, 1000n]]) {
    value = sample;
    now += 11;
    await assert.rejects(
      gate.assertNewWorkAllowed(),
      hasCode("storage_capacity_unknown"),
    );
    assert.deepEqual(gate.snapshot(), {
      state: "unknown",
      availableBytes: null,
    });
  }
  value = [150n, 500n];
  now += 11;
  await assert.rejects(
    gate.assertNewWorkAllowed(),
    hasCode("storage_capacity_low"),
  );
  value = [200n, 500n];
  now += 11;
  await gate.assertNewWorkAllowed();
  gate.close();
});

test("closing releases observation waiters and prevents another native read", async () => {
  let finish!: (value: readonly bigint[]) => void;
  const pending = new Promise<readonly bigint[]>((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  const gate = new FilesystemStorageAdmission(
    { paths, policy },
    {
      readAvailableBytes: async () => {
        reads++;
        return pending;
      },
    },
  );
  const rejected = assert.rejects(
    gate.assertNewWorkAllowed(),
    hasCode("storage_capacity_unknown"),
  );
  await Promise.resolve();
  gate.close();
  await rejected;
  finish([500n, 500n]);
  await setImmediate();
  await assert.rejects(
    gate.assertNewWorkAllowed(),
    hasCode("storage_capacity_unknown"),
  );
  assert.equal(reads, 1);
});

test("reads real available filesystem capacity without writing a filler file", async (context) => {
  const path = mkdtempSync(join(tmpdir(), "crewon-capacity-"));
  context.after(() => rmSync(path, { recursive: true, force: true }));
  const gate = new FilesystemStorageAdmission({
    paths: [path],
    policy: {
      ...policy,
      minimumAvailableBytes: 1n,
      recoveryAvailableBytes: 2n,
    },
  });
  context.after(() => gate.close());
  await gate.assertNewWorkAllowed();
  assert.ok(gate.snapshot().availableBytes! > 0n);
});

test("validates bounded configuration and closes only owned adapters", async () => {
  for (const invalid of [
    [],
    ["relative/path"],
    Array.from({ length: 9 }, () => "/path"),
  ]) {
    assert.throws(
      () => new FilesystemStorageAdmission({ paths: invalid, policy }),
      /storage_capacity_paths_invalid/,
    );
  }
  for (const invalid of [
    { minimumAvailableBytes: 0n },
    { recoveryAvailableBytes: 100n },
    { probeTimeoutMs: 0 },
    { snapshotMaxAgeMs: 60_001 },
  ]) {
    assert.throws(
      () =>
        new FilesystemStorageAdmission({
          paths,
          policy: { ...policy, ...invalid },
        }),
      /storage_capacity_policy_invalid/,
    );
  }
  const configured = { assertNewWorkAllowed: async () => {} };
  const owner = createLocalStorageAdmissionOwner({ configured, paths: [] });
  owner.close();
  assert.equal(owner.admission, configured);
  assert.equal(
    createLocalStorageAdmissionOwner({ paths: [":memory:"] }).admission,
    undefined,
  );
});

function hasCode(code: StorageAdmissionError["code"]) {
  return (error: unknown) =>
    error instanceof StorageAdmissionError &&
    error.code === code &&
    error.message === code;
}
