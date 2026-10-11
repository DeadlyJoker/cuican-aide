import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeTaskRuntimeFixture,
  actor,
} from "./desktop-native-plugin-task-runtime.test-support.ts";

const signal = () => new AbortController().signal;

test(
  "shared source bounds simultaneous storage work and retained references without creating more tasks",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await nativeTaskRuntimeFixture(t, undefined, {
      composition: true,
    });
    const task = (await f.invoke()) as { runId: string };
    const source = f.actual.workerRunSource!;
    const captures = await Promise.allSettled(
      Array.from({ length: 65 }, () => source.capture(task.runId, signal())),
    );
    const references = captures.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    assert.equal(references.length, 64);
    const rejection = captures.find((result) => result.status === "rejected");
    assert.ok(rejection?.status === "rejected");
    assert.match(
      String(rejection.reason),
      /desktop_worker_run_source_capacity/,
    );
    await assert.rejects(
      source.capture(task.runId, signal()),
      /desktop_worker_run_source_capacity/,
    );
    source.release(references[0]!);
    const replacement = await source.capture(task.runId, signal());
    assert.equal(
      (await source.verify(replacement, signal())).binding.runId,
      task.runId,
    );
    assert.equal(f.facts().runs, 1);
  },
);

test(
  "actual original Core source recovers the stored Run and immutable graph; copies do not become instance/task grants",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await nativeTaskRuntimeFixture(t, undefined, {
      composition: true,
    });
    const task = (await f.invoke()) as { runId: string };
    const source = f.actual.workerRunSource;
    assert.ok(source);
    const qualification = await source.capture(task.runId, signal());
    const snapshot = await source.verify(qualification, signal());
    assert.equal(snapshot.admission.actorId, actor.actorId);
    assert.equal(snapshot.admission.principalId, actor.principalId);
    assert.equal(snapshot.admission.profileId, f.scope.profileId);
    assert.equal(snapshot.binding.runId, task.runId);
    assert.ok(
      snapshot.binding.schemaVersion === "crewon.extension-run-binding.v1",
    );
    assert.equal(
      snapshot.composition?.lockDigest,
      snapshot.binding.composition.lockDigest,
    );
    await assert.rejects(
      source.verify({ ...qualification }, signal()),
      /desktop_worker_run_qualification_invalid/,
    );
    await assert.rejects(
      source.verify(JSON.parse(JSON.stringify(qualification)), signal()),
      /desktop_worker_run_qualification_invalid/,
    );
    await assert.rejects(
      source.capture("missing-native-run", signal()),
      /desktop_worker_run_admission_unavailable/,
    );
    assert.equal(f.facts().runs, 1);
    source.release(qualification);
    await assert.rejects(
      source.verify(qualification, signal()),
      /desktop_worker_run_qualification_invalid/,
    );
    const old = await source.capture(task.runId, signal());
    const reopened = await f.reopen();
    await assert.rejects(
      source.verify(old, signal()),
      /desktop_worker_run_source_closed/,
    );
    assert.ok(reopened.workerRunSource);
    await assert.rejects(
      reopened.workerRunSource.verify(old, signal()),
      /desktop_worker_run_qualification_invalid/,
    );
    const current = await reopened.workerRunSource.capture(
      task.runId,
      signal(),
    );
    assert.deepEqual(
      await reopened.workerRunSource.verify(current, signal()),
      snapshot,
    );
    assert.equal(f.facts().runs, 1);
  },
);

test(
  "source withdrawal and caller cancellation cannot publish a captured metadata qualification",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await nativeTaskRuntimeFixture(t, undefined, {
      composition: true,
    });
    const task = (await f.invoke()) as { runId: string };
    const source = f.actual.workerRunSource!;
    const cancelled = new AbortController();
    cancelled.abort(new Error("named_source_cancel"));
    await assert.rejects(
      source.capture(task.runId, cancelled.signal),
      /named_source_cancel/,
    );
    const capture = source.capture(task.runId, signal());
    void capture.catch(() => {});
    await f.actual.close();
    await assert.rejects(capture, /desktop_worker_run_source_closed/);
    await assert.rejects(
      source.capture(task.runId, signal()),
      /desktop_worker_run_source_closed/,
    );
    assert.equal(f.facts().runs, 1);
  },
);
