import test from "node:test";
import assert from "node:assert/strict";
import { ProjectConversationAssociationController } from "../src/workbench/ProjectConversationAssociationController.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const details = (projectId) => ({ project: { projectId, state: "active" } });
const candidate = {
  threadId: "original-thread",
  threadRevision: 7,
  workspaceId: "original-directory",
};
function setup() {
  const writes = [],
    reads = [],
    bindings = new Map();
  let responseLost = false,
    physical = false,
    gate = null,
    currentCandidate = candidate;
  const controller = new ProjectConversationAssociationController({
    physicalWritesPending: () => physical,
    async getBinding(input) {
      reads.push(input);
      return { binding: bindings.get(input.threadId) ?? null };
    },
    client: {
      async inspect(input) {
        return { candidate: { ...currentCandidate, threadId: input.threadId } };
      },
      async attach(input) {
        writes.push(structuredClone(input));
        if (gate) await gate;
        const binding = {
          ...input,
          workspaceId: input.workspaceId,
          state: "active",
        };
        bindings.set(input.threadId, binding);
        if (responseLost) throw new Error("lost_ack");
        return { disposition: "committed", binding };
      },
    },
  });
  return {
    controller,
    writes,
    reads,
    bindings,
    loseResponse: () => {
      responseLost = true;
    },
    physical: (value) => {
      physical = value;
      controller.refreshWriteActivity();
    },
    gate: (value) => {
      gate = value;
    },
    candidate: (value) => {
      currentCandidate = value;
    },
  };
}
test("association reads require the explicit current Thread and perform no write; confirmation retains its own workspace", async () => {
  const f = setup();
  try {
    f.controller.setContext({
      ready: true,
      threadId: null,
      details: details("project"),
    });
    await tick();
    assert.equal(f.reads.length, 0);
    f.controller.setContext({
      ready: true,
      threadId: "original-thread",
      details: details("project"),
    });
    await tick();
    assert.equal(f.writes.length, 0);
    assert.equal(f.controller.canAttach, true);
    f.physical(true);
    assert.equal(f.controller.canAttach, false);
    await f.controller.attach();
    assert.equal(f.writes.length, 0);
    f.physical(false);
    await f.controller.attach();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].workspaceId, candidate.workspaceId);
    assert.equal(f.writes[0].expectedThreadRevision, 7);
    assert.equal(f.controller.getSnapshot().attached, true);
  } finally {
    f.controller.dispose();
  }
});
test("lost association response is confirmed by canonical GET without another mutation or Run", async () => {
  const f = setup();
  try {
    f.controller.setContext({
      ready: true,
      threadId: "original-thread",
      details: details("project"),
    });
    await tick();
    f.loseResponse();
    await f.controller.attach();
    assert.ok(f.controller.getSnapshot().pending);
    assert.equal(f.controller.canAttach, false);
    await f.controller.refresh();
    assert.equal(f.writes.length, 1);
    assert.equal(f.controller.getSnapshot().pending, null);
    assert.equal(f.controller.getSnapshot().attached, true);
  } finally {
    f.controller.dispose();
  }
});
test("a reply after Thread switching cannot mark the new Thread as attached; read recovery targets the original request", async () => {
  const f = setup();
  let release;
  f.gate(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  try {
    f.controller.setContext({
      ready: true,
      threadId: "original-thread",
      details: details("project"),
    });
    await tick();
    const pending = f.controller.attach();
    f.controller.setContext({
      ready: true,
      threadId: "new-thread",
      details: details("project"),
    });
    release();
    await pending;
    await tick();
    await f.controller.refresh();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].threadId, "original-thread");
    assert.equal(f.controller.getSnapshot().attached, false);
    assert.equal(f.controller.getSnapshot().pending, null);
    assert.ok(
      f.reads.slice(1).every((input) => input.threadId === "original-thread"),
    );
  } finally {
    f.controller.dispose();
  }
});
test("cold read sees an existing association but never writes or automatically executes", async () => {
  const f = setup();
  f.bindings.set("original-thread", {
    projectId: "project",
    threadId: "original-thread",
    workspaceId: "original-directory",
    state: "active",
  });
  try {
    f.controller.setContext({
      ready: true,
      threadId: "original-thread",
      details: details("project"),
    });
    await tick();
    assert.equal(f.controller.getSnapshot().attached, true);
    assert.equal(f.controller.canAttach, false);
    assert.equal(f.writes.length, 0);
  } finally {
    f.controller.dispose();
  }
});
