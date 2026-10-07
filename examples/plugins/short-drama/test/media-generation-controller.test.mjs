import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import {
  mediaInputFixture,
  openMedia,
  characterDraft,
  settle,
} from "./media-input.test-support.mjs";
const { outputFiles } = await build({
  entryPoints: [
    new URL(
      "../src/workbench/ProjectMediaGenerationController.ts",
      import.meta.url,
    ).pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { ProjectMediaGenerationController } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);
async function fixture(t) {
  const f = mediaInputFixture(),
    inputs = await openMedia(f);
  characterDraft(inputs);
  await inputs.save();
  let intent = null,
    lose = false,
    gate = null,
    boundProject = f.projectId;
  const calls = [];
  const create = () =>
    new ProjectMediaGenerationController({
      client: {
        recover: async () => ({ intent }),
        generate: async (command) => {
          calls.push(structuredClone(command));
          intent = {
            request: {
              action: "crewon.project-media-generations.v1.generate",
              input: structuredClone(command),
            },
            phase: "dispatched",
            retryable: true,
            receipt: null,
          };
          if (gate) await gate;
          const receipt = {
            disposition: calls.length > 1 ? "replayed" : "committed",
            projectId: command.projectId,
            mediaInputId: command.mediaInputId,
            inputRevision: command.inputRevision,
            executionId: command.executionId,
            threadId: command.threadId,
            threadRevision: 5,
            runId: "original-run",
          };
          intent = { ...intent, phase: "accepted", receipt, retryable: false };
          if (lose) {
            lose = false;
            throw new Error("named-response-loss");
          }
          return receipt;
        },
      },
      conversations: {
        getBinding: async () => ({
          binding: {
            projectId: boundProject,
            threadId: "bound-thread",
            state: "active",
          },
        }),
        openConversation: async () => ({}),
      },
      physicalWritesPending: () => false,
    });
  const open = async () => {
    const c = create();
    c.setProject(f.details);
    c.setInput(inputs.getSnapshot().input, false);
    c.setThread({ threadId: "bound-thread", revision: 4 });
    c.setReady(true);
    c.activate();
    await settle();
    t.after(() => c.dispose());
    return c;
  };
  t.after(() => inputs.dispose());
  return {
    ...f,
    inputs,
    calls,
    open,
    loss: () => {
      lose = true;
    },
    gate: (p) => {
      gate = p;
    },
    foreign: () => {
      boundProject = "other-project";
    },
    intent: (value) => {
      intent = value;
    },
  };
}
test("generation activates read-only and uses saved input plus genuinely associated thread", async (t) => {
  const f = await fixture(t),
    c = await f.open();
  assert.equal(f.calls.length, 0);
  assert.equal(c.canGenerate, true);
  await c.generate();
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.calls[0].mediaInputId,
    f.inputs.getSnapshot().input.mediaInputId,
  );
  assert.equal(f.calls[0].expectedThreadRevision, 4);
  assert.equal(c.getSnapshot().status, "accepted");
});
test("foreign conversation and dirty inputs cannot start preparation", async (t) => {
  const f = await fixture(t),
    c = await f.open();
  c.setInput(f.inputs.getSnapshot().input, true);
  await c.generate();
  assert.equal(f.calls.length, 0);
  c.setInput(f.inputs.getSnapshot().input, false);
  f.foreign();
  await c.generate();
  assert.equal(f.calls.length, 0);
  assert.match(c.getSnapshot().error, /没有关联/);
});
test("lost accepted response recovers on a cold controller without another generation", async (t) => {
  const f = await fixture(t),
    c = await f.open();
  f.loss();
  await c.generate();
  assert.equal(c.getSnapshot().status, "uncertain");
  assert.equal(c.canGenerate, false);
  c.dispose();
  const cold = await f.open();
  assert.equal(cold.getSnapshot().status, "accepted");
  assert.equal(cold.getSnapshot().receipt.runId, "original-run");
  assert.equal(f.calls.length, 1);
});
test("pending recovery only retries the full original request and does not follow a newer thread revision", async (t) => {
  const f = await fixture(t),
    c = await f.open();
  f.loss();
  await c.generate();
  const original = f.calls[0];
  f.intent({
    request: {
      action: "crewon.project-media-generations.v1.generate",
      input: original,
    },
    phase: "dispatched",
    retryable: true,
    receipt: null,
  });
  await c.recover();
  c.setThread({ threadId: "bound-thread", revision: 9 });
  await c.retry();
  assert.deepEqual(f.calls[1], original);
  assert.equal(c.getSnapshot().status, "accepted");
});
test("theme-like repeated readiness does not execute; disposal prevents late receipts updating the old page", async (t) => {
  const f = await fixture(t),
    c = await f.open();
  c.setReady(true);
  c.setThread({ threadId: "bound-thread", revision: 4 });
  assert.equal(f.calls.length, 0);
  let release;
  f.gate(
    new Promise((r) => {
      release = r;
    }),
  );
  const pending = c.generate();
  await settle();
  c.dispose();
  const before = c.getSnapshot();
  release();
  await pending;
  assert.equal(c.getSnapshot(), before);
});

test("another project's accepted task is never shown as this project's result", async (t) => {
  const f = await fixture(t),
    c = await f.open();
  await c.generate();
  const request = { ...f.calls[0], projectId: "other-project" };
  f.intent({
    request: {
      action: "crewon.project-media-generations.v1.generate",
      input: request,
    },
    phase: "accepted",
    retryable: false,
    receipt: { ...c.getSnapshot().receipt, projectId: "other-project" },
  });
  await c.recover();
  assert.equal(c.getSnapshot().receipt, null);
  assert.equal(c.getSnapshot().status, "idle");
  assert.equal(c.canGenerate, true);
  c.setInput(
    { ...f.inputs.getSnapshot().input, projectId: "other-project" },
    false,
  );
  assert.equal(c.canGenerate, false);
  await c.generate();
  assert.equal(f.calls.length, 1);
});
test("another project's pending request blocks new generation but permits navigation back", async (t) => {
  const f = await fixture(t),
    c = await f.open();
  await c.generate();
  f.intent({
    request: {
      action: "crewon.project-media-generations.v1.generate",
      input: { ...f.calls[0], projectId: "other-project" },
    },
    phase: "dispatched",
    retryable: true,
    receipt: null,
  });
  await c.recover();
  assert.equal(c.foreignIntent, true);
  assert.equal(c.locked, false);
  assert.equal(c.canGenerate, false);
  assert.equal(c.canRetry, false);
  await c.generate();
  await c.retry();
  assert.equal(f.calls.length, 1);
});
