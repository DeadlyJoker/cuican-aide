import assert from "node:assert/strict";
import test from "node:test";

import type {
  ActorContext,
  ModelProviderProbeResult,
} from "@crewon/application";

import {
  ProviderProbeIdempotencyCoordinator,
  ProviderProbeIdempotencyError,
} from "./provider-probe-idempotency.ts";

const actor: ActorContext = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};

const result: ModelProviderProbeResult = {
  providerId: "gateway",
  catalogRevision: 1,
  runtimeBindingId: "runtime-generation-1",
  status: "ok",
  models: [],
  modelCount: 0,
  latencyMs: 1,
  retryable: false,
  retryAfterMs: null,
};

test("coalesces concurrent retries and replays after caller abort", async () => {
  let resolve!: (value: ModelProviderProbeResult) => void;
  let calls = 0;
  const coordinator = new ProviderProbeIdempotencyCoordinator({
    probe: async () => {
      calls += 1;
      return new Promise<ModelProviderProbeResult>((next) => {
        resolve = next;
      });
    },
  });
  const aborted = new AbortController();
  const idempotency = { key: "same-key", fingerprint: "fingerprint-1" };
  const first = coordinator.probe(actor, idempotency, aborted.signal);
  const replay = coordinator.probe(
    actor,
    idempotency,
    new AbortController().signal,
  );
  aborted.abort(new Error("client_disconnected"));
  await assert.rejects(first, /client_disconnected/u);
  resolve(result);
  assert.deepEqual(await replay, { disposition: "replayed", result });
  assert.equal(calls, 1);
});

test("expires deterministically and scopes keys to verified actor identity", async () => {
  let now = 0;
  let calls = 0;
  const coordinator = new ProviderProbeIdempotencyCoordinator(
    {
      probe: async () => {
        calls += 1;
        return result;
      },
    },
    { clock: () => now, ttlMs: 10 },
  );
  const signal = new AbortController().signal;
  assert.equal(
    (await coordinator.probe(actor, idempotency("key"), signal)).disposition,
    "completed",
  );
  assert.equal(
    (
      await coordinator.probe(
        { ...actor, actorId: "actor-2" },
        idempotency("key"),
        signal,
      )
    ).disposition,
    "completed",
  );
  now = 10;
  assert.equal(
    (await coordinator.probe(actor, idempotency("key"), signal)).disposition,
    "completed",
  );
  assert.equal(calls, 3);
});

test("does not expire an in-flight same-key probe", async () => {
  let now = 0;
  let calls = 0;
  let resolve!: (value: ModelProviderProbeResult) => void;
  const coordinator = new ProviderProbeIdempotencyCoordinator(
    {
      probe: async () => {
        calls += 1;
        return new Promise<ModelProviderProbeResult>((next) => {
          resolve = next;
        });
      },
    },
    { clock: () => now, ttlMs: 1 },
  );
  const signal = new AbortController().signal;
  const first = coordinator.probe(actor, idempotency("key"), signal);
  now = 10;
  const replay = coordinator.probe(actor, idempotency("key"), signal);
  assert.equal(calls, 1);
  resolve(result);
  assert.deepEqual(await first, { disposition: "completed", result });
  assert.deepEqual(await replay, { disposition: "replayed", result });
});

test("fails closed when capacity contains only an in-flight probe", async () => {
  let calls = 0;
  const coordinator = new ProviderProbeIdempotencyCoordinator(
    {
      probe: async () => {
        calls += 1;
        return new Promise<ModelProviderProbeResult>(() => {});
      },
    },
    { maximumEntries: 1 },
  );
  void coordinator.probe(
    actor,
    idempotency("pending-key"),
    new AbortController().signal,
  );
  await assert.rejects(
    coordinator.probe(
      actor,
      idempotency("new-key"),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof ProviderProbeIdempotencyError &&
      error.code === "provider_probe_idempotency_capacity_exhausted",
  );
  assert.equal(calls, 1);
});

test("evicts settled entries deterministically when capacity is needed", async () => {
  let calls = 0;
  const coordinator = new ProviderProbeIdempotencyCoordinator(
    {
      probe: async () => {
        calls += 1;
        return result;
      },
    },
    { maximumEntries: 1 },
  );
  const signal = new AbortController().signal;
  await coordinator.probe(actor, idempotency("old-key"), signal);
  await coordinator.probe(actor, idempotency("new-key"), signal);
  await coordinator.probe(actor, idempotency("old-key"), signal);
  assert.equal(calls, 3);
});

for (const clock of [Number.NaN, Number.MAX_SAFE_INTEGER]) {
  test(`fails closed on invalid authority clock ${String(clock)}`, async () => {
    const coordinator = new ProviderProbeIdempotencyCoordinator(
      { probe: async () => result },
      { clock: () => clock },
    );
    await assert.rejects(
      coordinator.probe(
        actor,
        idempotency("key"),
        new AbortController().signal,
      ),
      /provider_probe_clock_invalid/u,
    );
  });
}

test("rejects same-key fingerprint drift without dispatching", async () => {
  let calls = 0;
  const coordinator = new ProviderProbeIdempotencyCoordinator({
    probe: async () => {
      calls += 1;
      return result;
    },
  });
  const signal = new AbortController().signal;
  await coordinator.probe(actor, idempotency("key", "fingerprint-1"), signal);
  await assert.rejects(
    coordinator.probe(actor, idempotency("key", "fingerprint-2"), signal),
    (error) =>
      error instanceof ProviderProbeIdempotencyError &&
      error.code === "provider_probe_idempotency_conflict",
  );
  assert.equal(calls, 1);
});

test("replays unknown outcomes but permits a retry after notSent", async () => {
  for (const certainty of ["possiblySent", "notSent"] as const) {
    let calls = 0;
    const failure = Object.assign(new Error(certainty), { certainty });
    const coordinator = new ProviderProbeIdempotencyCoordinator({
      probe: async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return result;
      },
    });
    const signal = new AbortController().signal;
    await assert.rejects(
      coordinator.probe(actor, idempotency("key"), signal),
      (error) => error === failure,
    );
    if (certainty === "possiblySent") {
      await assert.rejects(
        coordinator.probe(actor, idempotency("key"), signal),
        (error) => error === failure,
      );
      assert.equal(calls, 1);
    } else {
      assert.equal(
        (await coordinator.probe(actor, idempotency("key"), signal))
          .disposition,
        "completed",
      );
      assert.equal(calls, 2);
    }
  }
});

function idempotency(key: string, fingerprint = "fingerprint-1") {
  return { key, fingerprint };
}
