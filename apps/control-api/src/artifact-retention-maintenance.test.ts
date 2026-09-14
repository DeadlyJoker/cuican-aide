import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InMemoryArtifactStore,
  DEFAULT_ARTIFACT_RETENTION,
} from "@crewon/artifacts";
import type {
  ArtifactRetentionResult,
  ArtifactRetentionStore,
} from "@crewon/application";
import {
  ArtifactRetentionMaintenance,
  configuredArtifactRetention,
} from "./artifact-retention-maintenance.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";

const result: ArtifactRetentionResult = {
  disposition: "maintained",
  indexed: 1,
  checked: 1,
  deleted: 1,
  deletedBytes: 100,
};
const guard = { canRetireArtifact: async () => false };
const policy = { ...DEFAULT_ARTIFACT_RETENTION, minimumIntervalMs: 100 };
test("maintenance waits for one physical pass, cancels on close and never starts a scan during construction", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0,
    release!: (r: ArtifactRetentionResult) => void,
    signal: AbortSignal | undefined;
  const pending = new Promise<ArtifactRetentionResult>((r) => {
    release = r;
  });
  const maintenance = new ArtifactRetentionMaintenance(
    {
      maintainArtifacts: async (input) => {
        calls++;
        signal = input.signal;
        return pending;
      },
    },
    guard,
    policy,
  );
  maintenance.start();
  maintenance.start();
  assert.equal(calls, 0);
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
  t.mock.timers.tick(10000);
  assert.equal(calls, 1);
  const closing = maintenance.close();
  assert.equal(signal?.aborted, true);
  t.mock.timers.tick(10000);
  assert.equal(calls, 1);
  release(result);
  await closing;
  assert.equal(maintenance.status().inFlight, false);
  await maintenance.wake();
  assert.equal(calls, 1);
});
test("maintenance isolates diagnostic failures and honors explicit disabling and invalid policies", async () => {
  let fail = true,
    calls = 0;
  const store = {
    maintainArtifacts: async () => {
      calls++;
      if (fail) throw new Error("secret sqlite database detail");
      return result;
    },
  };
  const m = new ArtifactRetentionMaintenance(store, guard, policy);
  await m.wake();
  assert.equal(m.status().lastFailureCode, "artifact_maintenance_failed");
  fail = false;
  await m.wake();
  assert.deepEqual(m.status().lastResult, result);
  assert.equal(m.status().lastFailureCode, null);
  await m.close();
  for (const disabled of [
    new ArtifactRetentionMaintenance(undefined, guard, policy),
    new ArtifactRetentionMaintenance(store, guard, null),
  ]) {
    disabled.start();
    await disabled.wake();
    await disabled.close();
  }
  assert.equal(calls, 2);
  assert.equal(configuredArtifactRetention("off"), null);
  assert.deepEqual(
    configuredArtifactRetention(undefined),
    DEFAULT_ARTIFACT_RETENTION,
  );
  assert.throws(() => configuredArtifactRetention("unknown"));
  for (const invalid of [
    { maxRecords: 101 },
    { maxDurationMs: 0 },
    { maxBytes: NaN },
    { recoveryGraceMs: -1 },
  ])
    assert.throws(
      () =>
        new ArtifactRetentionMaintenance(store, guard, {
          ...policy,
          ...invalid,
        }),
    );
});
test("actual Control composition owns the optional maintenance and closes it before the artifact authority", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-artifact-api-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0,
    closed = false;
  class Artifacts extends InMemoryArtifactStore {
    readonly retention: ArtifactRetentionStore = {
      maintainArtifacts: async (input) => {
        assert(!closed);
        assert.equal(typeof input.guard.canRetireArtifact, "function");
        calls++;
        return result;
      },
    };
    override async close() {
      closed = true;
      await super.close();
    }
  }
  const runtime = createStandaloneControlApi({
    databasePath: join(directory, "runtime.sqlite"),
    actor: {
      principalId: "principal",
      actorId: "actor",
      tenantId: "tenant",
      spaceId: "space",
    },
    sessionToken: "artifact-maintenance-session-token-32-characters",
    csrfToken: "artifact-maintenance-csrf-token-32-characters",
    allowedOrigins: ["http://127.0.0.1:5175"],
    defaultAgentVersionId: "agent",
    artifactStore: new Artifacts(),
    artifactEncryptionKeyId: "key",
    artifactRetention: policy,
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
  });
  t.after(() => runtime.app.close());
  assert.equal(calls, 0);
  await runtime.artifactMaintenance.wake();
  assert.equal(calls, 1);
  await runtime.app.close();
  assert(closed);
  await runtime.artifactMaintenance.wake();
  assert.equal(calls, 1);
});
