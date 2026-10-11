import assert from "node:assert/strict";
import test from "node:test";
import { modelCallGoalFixture } from "./model-call-goal.test-support.ts";

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: HTTP diagnostics enrich an admitted call without changing identity and survive reopen`, async (t) => {
    const f = await modelCallGoalFixture(t, backend);
    const legacy = f.intent("legacy-http");
    await f.store().recordModelCall(legacy);
    await f.reopen();
    const legacyRow = (await f.rows())[0]!.record.observation;
    assert.equal(Object.hasOwn(legacyRow, "httpDiagnostics"), false);
    assert.equal(Object.hasOwn(legacyRow, "httpTiming"), false);
    const intent = f.intent("diagnosed-http");
    await f.store().recordModelCall(intent);
    const finish = {
      ...intent,
      record: {
        ...intent.record,
        observation: {
          ...intent.record.observation,
          outcome: "failed" as const,
          finishedAt: "2026-08-08T00:01:03Z",
          httpTiming: {
            admittedMs: 1,
            dispatchedMs: 2,
            headersMs: 5,
            finishedMs: 7,
          },
          httpDiagnostics: {
            response: {
              status: 524,
              contentType: "text/html",
              server: "cloudflare",
              cfRay: "ray-SJC",
              oneApiRequestId: "req-1",
            },
            termination: {
              reason: "httpError" as const,
              code: "responses_provider_unavailable",
            },
          },
        },
      },
    };
    assert.equal(await f.store().recordModelCall(finish), "enriched");
    assert.equal(await f.store().recordModelCall(intent), "replayed");
    assert.equal(await f.store().recordModelCall(finish), "replayed");
    const before = await f.rows();
    await f.reopen();
    assert.deepEqual(await f.rows(), before);
    assert.deepEqual(
      before[1]!.record.observation.httpDiagnostics,
      finish.record.observation.httpDiagnostics,
    );
    const { httpDiagnostics: _removedDiagnostics, ...withoutDiagnostics } =
      finish.record.observation;
    for (const observation of [
      { ...finish.record.observation, modelId: "changed-model" },
      {
        ...finish.record.observation,
        httpDiagnostics: { response: { status: 502 } },
      },
      withoutDiagnostics,
      { ...finish.record.observation, httpTiming: { finishedMs: 99 } },
    ])
      await assert.rejects(
        f.store().recordModelCall({
          ...finish,
          record: { ...finish.record, observation },
        }),
        { code: "model_call_conflict" },
      );
    await assert.rejects(
      f.store().recordModelCall({
        ...intent,
        record: {
          ...intent.record,
          observation: {
            ...intent.record.observation,
            httpDiagnostics: { response: { status: 200 } },
          },
        },
      }),
      { code: "model_call_record_invalid" },
    );
    await assert.rejects(
      f.store().recordModelCall({
        ...finish,
        record: {
          ...finish.record,
          observation: {
            ...finish.record.observation,
            httpDiagnostics: {
              response: { status: 524, cookie: "secret" },
            } as never,
          },
        },
      }),
      { code: "model_call_record_invalid" },
    );
  });
}
