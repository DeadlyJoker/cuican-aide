import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { deferred } from "./persistent-ui.test-support.mjs";
const built = await build({
  entryPoints: [
    new URL("../src/workbench/ProjectMediaOutputController.ts", import.meta.url)
      .pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node24",
});
const { ProjectMediaOutputController } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
);
function fixture(t) {
  const receipt = {
    projectId: "project-a",
    runId: "original-run",
    mediaInputId: "original-input",
    inputRevision: 2,
  };
  const calls = [],
    saved = new Map();
  const state = {
    readGate: null,
    saveGate: null,
    lose: false,
    refuse: false,
    physical: false,
    wrongSource: false,
  };
  const candidate = (index) => ({
    ...receipt,
    resultIndex: index,
    candidateId: `candidate-${index}`,
  });
  const controller = new ProjectMediaOutputController(
    {
      async listOutputs(q, options) {
        calls.push({ action: "read", q, signal: options.signal });
        await state.readGate;
        return {
          ...receipt,
          inputRevision: state.wrongSource ? 3 : 2,
          outputs: [0, 1].map((resultIndex) => ({
            resultIndex,
            candidate: saved.get(resultIndex) ?? null,
          })),
        };
      },
      async saveCandidate(q, options) {
        calls.push({ action: "save", q, signal: options.signal });
        await state.saveGate;
        if (state.refuse) {
          state.refuse = false;
          throw new Error("named-lost-no-commit");
        }
        const replay = saved.has(q.resultIndex);
        saved.set(q.resultIndex, candidate(q.resultIndex));
        if (state.lose) {
          state.lose = false;
          throw new Error("private supplier detail");
        }
        return {
          disposition: replay ? "replayed" : "created",
          candidate: saved.get(q.resultIndex),
        };
      },
    },
    () => state.physical,
  );
  controller.setReady(true);
  controller.setSource(receipt.projectId, receipt);
  t.after(() => controller.dispose());
  return { controller, state, calls, receipt, saved };
}
test("only observed original positions can be saved; selecting another input does not rewrite their receipt", async (t) => {
  const f = fixture(t),
    c = f.controller;
  await c.save(0);
  assert.equal(f.calls.length, 0);
  await c.refresh();
  await c.save(2);
  assert.equal(f.calls.length, 1);
  await c.save(1);
  assert.deepEqual(f.calls[1].q, {
    projectId: "project-a",
    runId: "original-run",
    resultIndex: 1,
  });
  assert.equal(c.getSnapshot().outputs[1].candidate.inputRevision, 2);
  assert.equal(c.locked, false);
  await c.save(1);
  assert.equal(f.calls.length, 2);
});
test("lost committed response is reconciled by reading the same position without another save", async (t) => {
  const f = fixture(t),
    c = f.controller;
  await c.refresh();
  f.state.lose = true;
  await c.save(1);
  assert.equal(c.locked, true);
  assert.equal(c.canRetry, false);
  assert.ok(!c.getSnapshot().error.includes("private"));
  await c.save(0);
  await c.retry();
  assert.equal(f.calls.length, 2);
  await c.refresh();
  assert.equal(c.locked, false);
  assert.ok(c.candidate(1));
  assert.equal(f.calls.filter((x) => x.action === "save").length, 1);
});
test("after an inconclusive save only explicit retry of the original position is enabled", async (t) => {
  const f = fixture(t),
    c = f.controller;
  await c.refresh();
  f.state.refuse = true;
  await c.save(1);
  await c.refresh();
  assert.equal(c.canRetry, true);
  assert.equal(c.canSave(0), false);
  await c.save(0);
  await c.retry();
  const saves = f.calls.filter((x) => x.action === "save");
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[0].q, saves[1].q);
  assert.equal(c.getSnapshot().uncertain, null);
});
test("late reads and writes never populate a different project's current source", async (t) => {
  const f = fixture(t),
    c = f.controller,
    gate = deferred();
  f.state.readGate = gate.promise;
  const read = c.refresh();
  c.setSource("project-b", f.receipt);
  gate.resolve();
  await read;
  assert.equal(c.getSnapshot().source, null);
  assert.deepEqual(c.getSnapshot().outputs, []);
  f.state.readGate = null;
  c.setSource("project-a", f.receipt);
  await c.refresh();
  const saving = deferred();
  f.state.saveGate = saving.promise;
  const pending = c.save(1);
  c.setSource("project-b", {
    ...f.receipt,
    projectId: "project-b",
    runId: "other-run",
  });
  assert.equal(c.canRead, false);
  saving.resolve();
  await pending;
  assert.equal(c.getSnapshot().source.runId, "other-run");
  assert.deepEqual(c.getSnapshot().outputs, []);
});
test("readiness withdrawal and stop waiting retain uncertainty and wait for the physical call to settle", async (t) => {
  const f = fixture(t),
    c = f.controller;
  await c.refresh();
  const gate = deferred();
  f.state.saveGate = gate.promise;
  const pending = c.save(0);
  c.setReady(false);
  c.setReady(true);
  assert.equal(c.canRead, false);
  assert.equal(c.getSnapshot().saving, null);
  assert.equal(c.getSnapshot().uncertain, 0);
  gate.resolve();
  await pending;
  f.state.physical = true;
  assert.equal(c.canRead, false);
  f.state.physical = false;
  c.refreshWriteActivity();
  await c.refresh();
  assert.equal(c.locked, false);
  assert.ok(c.candidate(0));
});
test("a result tied to another accepted input version cannot become saveable", async (t) => {
  const f = fixture(t),
    c = f.controller;
  f.state.wrongSource = true;
  await c.refresh();
  assert.equal(c.getSnapshot().phase, "unavailable");
  await c.save(0);
  assert.equal(f.calls.length, 1);
  f.state.wrongSource = false;
  await c.refresh();
  assert.equal(c.canSave(0), true);
});
test("dispose aborts pending work and suppresses late notifications", async (t) => {
  const f = fixture(t),
    c = f.controller;
  await c.refresh();
  const gate = deferred();
  f.state.saveGate = gate.promise;
  const pending = c.save(0);
  let changes = 0;
  c.subscribe(() => changes++);
  c.dispose();
  assert.equal(f.calls.at(-1).signal.aborted, true);
  gate.resolve();
  await pending;
  assert.equal(changes, 0);
  assert.equal(c.getSnapshot().source, null);
});
