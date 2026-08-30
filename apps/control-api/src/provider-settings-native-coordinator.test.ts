import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type LeaseClock, SqliteRunStore } from "@crewon/store";

import { runNativeProviderCoordinator } from "./provider-settings-native-coordinator.ts";

test("drives durable prepare, replay, finalize and inspect without exposing candidate internals", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-native-provider-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(directory, "control.sqlite"));
  t.after(() => store.close());
  const dependencies = { store };
  const prepared = await runNativeProviderCoordinator(
    prepareCommand(),
    dependencies,
  );
  assert.deepEqual(prepared, {
    phase: "prepare",
    disposition: "prepared",
    catalog: null,
    pending: {
      operationId: "operation-1",
      baseRevision: 0,
      runtimeBindingId: "desktop-supervisor:generation-1",
      expiresAt: prepared.pending?.expiresAt,
    },
  });
  assert.equal(
    (await runNativeProviderCoordinator(prepareCommand(), dependencies))
      .disposition,
    "replayed",
  );
  assert.deepEqual(
    await runNativeProviderCoordinator({ phase: "inspect" }, dependencies),
    { ...prepared, phase: "inspect", disposition: null },
  );

  const finalized = await runNativeProviderCoordinator(
    {
      phase: "finalize",
      operationId: "operation-1",
      runtimeBindingId: "desktop-supervisor:generation-1",
    },
    dependencies,
  );
  assert.deepEqual(finalized, {
    phase: "finalize",
    disposition: "finalized",
    catalog: {
      revision: 1,
      activeProviderId: "gateway",
      runtimeBindingId: "desktop-supervisor:generation-1",
    },
    pending: null,
  });
  assert.equal(JSON.stringify(finalized).includes("endpoint"), false);
  assert.equal(JSON.stringify(finalized).includes("secret"), false);
  assert.equal(
    (
      await runNativeProviderCoordinator(
        {
          phase: "finalize",
          operationId: "operation-1",
          runtimeBindingId: "desktop-supervisor:generation-1",
        },
        dependencies,
      )
    ).disposition,
    "replayed",
  );
  assert.deepEqual(
    await runNativeProviderCoordinator(
      {
        phase: "recover",
        operationId: "operation-1",
        runtimeBindingId: "desktop-supervisor:generation-1",
        recoveryBinding: "operation-1:recovery",
      },
      dependencies,
    ),
    {
      phase: "recover",
      disposition: "finalized",
      catalog: finalized.catalog,
      pending: null,
    },
  );

  await runNativeProviderCoordinator(
    {
      ...prepareCommand(),
      operationId: "operation-2",
      runtimeBindingId: "desktop-supervisor:generation-2",
      expectedRevision: 1,
    },
    dependencies,
  );
  const recovered = await runNativeProviderCoordinator(
    {
      phase: "recover",
      operationId: "operation-2",
      runtimeBindingId: "desktop-supervisor:generation-2",
      recoveryBinding: "operation-2:recovery",
    },
    dependencies,
  );
  assert.deepEqual(recovered, {
    phase: "recover",
    disposition: "aborted",
    catalog: finalized.catalog,
    pending: null,
  });
});

test("recovers an expired native operation through its durable expire receipt", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-native-provider-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = new MutableClock(Date.parse("2026-08-09T00:00:00.000Z"));
  const store = new SqliteRunStore(join(directory, "control.sqlite"), {
    clock,
  });
  t.after(() => store.close());
  await runNativeProviderCoordinator(prepareCommand(), { store });
  clock.now += 300_001;

  const recovered = await runNativeProviderCoordinator(
    {
      phase: "recover",
      operationId: "operation-1",
      runtimeBindingId: "desktop-supervisor:generation-1",
      recoveryBinding: "operation-1:recovery",
    },
    { store },
  );
  assert.deepEqual(recovered, {
    phase: "recover",
    disposition: "expired",
    catalog: null,
    pending: null,
  });
  assert.equal(
    (
      await runNativeProviderCoordinator(
        {
          phase: "recover",
          operationId: "operation-1",
          runtimeBindingId: "desktop-supervisor:generation-1",
          recoveryBinding: "operation-1:recovery",
        },
        { store },
      )
    ).disposition,
    "expired",
  );
});

test("rejects renderer-shaped authority injection before Store access", async () => {
  let reads = 0;
  const store = {
    loadModelProviderSettingsState: async () => {
      reads += 1;
      throw new Error("unexpected");
    },
  };
  await assert.rejects(
    runNativeProviderCoordinator(
      { ...prepareCommand(), actorId: "renderer-actor" },
      { store: store as never },
    ),
    /provider_native_command_invalid/u,
  );
  assert.equal(reads, 0);
});

test("reports an unprepared crash journal as missing without mutating authority", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-native-provider-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(directory, "control.sqlite"));
  t.after(() => store.close());

  assert.deepEqual(
    await runNativeProviderCoordinator(
      {
        phase: "recover",
        operationId: "unprepared-operation",
        runtimeBindingId: "unprepared-operation:disabled",
        recoveryBinding: "unprepared-operation:recovery",
      },
      { store },
    ),
    {
      phase: "recover",
      disposition: "missing",
      catalog: null,
      pending: null,
    },
  );
});

function prepareCommand() {
  return {
    phase: "prepare",
    operationId: "operation-1",
    runtimeBindingId: "desktop-supervisor:generation-1",
    expectedRevision: 0,
    activeProviderId: "gateway",
    bindings: [
      {
        providerId: "gateway",
        displayName: "Gateway",
        endpoint: "https://provider.example/v1",
        credentialKind: "keychain",
        environmentVariable: null,
      },
    ],
    ttlMs: 300_000,
  } as const;
}

class MutableClock implements LeaseClock {
  now: number;

  constructor(now: number) {
    this.now = now;
  }

  nowEpochMilliseconds(): number {
    return this.now;
  }
}
