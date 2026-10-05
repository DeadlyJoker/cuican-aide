import assert from "node:assert/strict";
import test from "node:test";
import { ProjectConversationController } from "../src/workbench/ProjectConversationController.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const details = (projectId) => ({ project: { projectId, state: "active" } });
const binding = (projectId, workspaceId, threadId = "test-thread") => ({
  bindingId: "test-binding",
  projectId,
  threadId,
  workspaceId,
  revision: 1,
  state: "active",
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "16.0.0",
    packageDigest: "sha256:" + "a".repeat(64),
    selectionRevision: 1,
  },
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
});
/** Public DTO ports only. Real binding/Run authority and atomic databases have separate Host coverage. */
async function fixture(client, projectId = "test-project") {
  let physical = false;
  const controller = new ProjectConversationController({
    client,
    physicalWritesPending: () => physical,
  });
  controller.setWorkspace({ workspaceId: "workspace-one", name: "工作空间一" });
  controller.setProject(details(projectId));
  controller.setReady(true);
  await tick();
  return {
    controller,
    physical: (value) => {
      physical = value;
      controller.refreshWriteActivity();
    },
  };
}
test("project conversation reads never adopt an unrelated selected chat or create a Thread automatically", async () => {
  const calls = [];
  const f = await fixture({
    async listConversations(input) {
      calls.push(input);
      return { bindings: [], nextThreadId: null };
    },
    async createConversation() {
      assert.fail("read must not create");
    },
    async openConversation() {
      assert.fail("read must not navigate");
    },
  });
  try {
    assert.deepEqual(calls, [
      { projectId: "test-project", afterThreadId: null, limit: 8 },
    ]);
    assert.equal(f.controller.canCreate, true);
    f.controller.setWorkspace(null);
    assert.equal(f.controller.canCreate, false);
    f.controller.setWorkspace({ workspaceId: null, name: null });
    assert.equal(f.controller.canCreate, true);
  } finally {
    f.controller.dispose();
  }
});
test("late metadata for an old project cannot replace the new project's actual bindings", async () => {
  const old = deferred();
  const f = await fixture({
    async listConversations(input) {
      return input.projectId === "test-project"
        ? old.promise
        : {
            bindings: [binding(input.projectId, null, "new-thread")],
            nextThreadId: null,
          };
    },
  });
  try {
    f.controller.setProject(details("new-project"));
    await tick();
    old.resolve({
      bindings: [binding("test-project", "workspace-one")],
      nextThreadId: null,
    });
    await tick();
    assert.equal(f.controller.getSnapshot().projectId, "new-project");
    assert.deepEqual(
      f.controller.getSnapshot().bindings.map((item) => item.threadId),
      ["new-thread"],
    );
  } finally {
    f.controller.dispose();
  }
});
test("unknown creation retry preserves its original workspace, body and key after new Host hints", async () => {
  const calls = [],
    receipts = new Map();
  let lost = true;
  const f = await fixture({
    async listConversations() {
      return { bindings: [...receipts.values()], nextThreadId: null };
    },
    async createConversation(input) {
      calls.push(structuredClone(input));
      const existing = receipts.get(input.idempotencyKey);
      const result = existing ?? binding(input.projectId, input.workspaceId);
      receipts.set(input.idempotencyKey, result);
      if (lost) {
        lost = false;
        throw new Error("lost_creation_ack");
      }
      return {
        disposition: existing ? "replayed" : "committed",
        binding: result,
      };
    },
  });
  try {
    await f.controller.create();
    const original = calls[0];
    assert.equal(
      f.controller.getSnapshot().pendingCreation.idempotencyKey,
      original.idempotencyKey,
    );
    f.controller.setWorkspace({
      workspaceId: "workspace-two",
      name: "工作空间二",
    });
    await f.controller.create();
    assert.equal(calls.length, 1);
    f.physical(true);
    await f.controller.retryCreation();
    assert.equal(calls.length, 1);
    f.physical(false);
    await f.controller.retryCreation();
    assert.deepEqual(calls[1], original);
    assert.equal(receipts.size, 1);
    assert.equal(f.controller.getSnapshot().pendingCreation, null);
    assert.equal(
      f.controller.getSnapshot().bindings[0].workspaceId,
      "workspace-one",
    );
  } finally {
    f.controller.dispose();
  }
});
test("confirmed creation is not changed to unknown when the follow-up metadata read fails", async () => {
  let reads = 0;
  const f = await fixture({
    async listConversations() {
      if (++reads > 1) throw new Error("metadata_read_unavailable");
      return { bindings: [], nextThreadId: null };
    },
    async createConversation(input) {
      return {
        disposition: "committed",
        binding: binding(input.projectId, input.workspaceId),
      };
    },
  });
  try {
    await f.controller.create();
    assert.equal(f.controller.getSnapshot().pendingCreation, null);
    assert.match(f.controller.getSnapshot().notice, /已创建/u);
    assert.equal(f.controller.getSnapshot().phase, "unavailable");
    assert.doesNotMatch(f.controller.getSnapshot().error, /尚未确认/u);
  } finally {
    f.controller.dispose();
  }
});
test("withdrawal keeps the dispatched original creation and prevents its late result from publishing", async () => {
  const delayed = deferred();
  const calls = [];
  const f = await fixture({
    async listConversations() {
      return { bindings: [], nextThreadId: null };
    },
    async createConversation(input) {
      calls.push(structuredClone(input));
      return calls.length === 1
        ? delayed.promise
        : {
            disposition: "replayed",
            binding: binding(input.projectId, input.workspaceId),
          };
    },
  });
  try {
    const writing = f.controller.create();
    f.controller.setReady(false);
    delayed.resolve({
      disposition: "committed",
      binding: binding("test-project", "workspace-one"),
    });
    await writing;
    assert.equal(f.controller.getSnapshot().phase, "waiting");
    assert.equal(
      f.controller.getSnapshot().pendingCreation.idempotencyKey,
      calls[0].idempotencyKey,
    );
    assert.equal(f.controller.getSnapshot().bindings.length, 0);
    f.controller.setReady(true);
    await tick();
    await f.controller.retryCreation();
    assert.deepEqual(calls[1], calls[0]);
  } finally {
    f.controller.dispose();
  }
});
test("open only sends a read for the actual binding and rejects a different workspace response", async () => {
  const calls = [];
  const f = await fixture({
    async listConversations() {
      return {
        bindings: [binding("test-project", "workspace-one")],
        nextThreadId: null,
      };
    },
    async openConversation(input) {
      calls.push(input);
      return {
        binding: binding(input.projectId, "foreign-workspace", input.threadId),
      };
    },
  });
  try {
    await f.controller.open("unrelated-global-thread");
    assert.equal(calls.length, 0);
    await f.controller.open("test-thread");
    assert.deepEqual(calls, [
      { projectId: "test-project", threadId: "test-thread" },
    ]);
    assert.equal(f.controller.getSnapshot().openingThreadId, null);
    assert.match(f.controller.getSnapshot().error, /无法打开/u);
  } finally {
    f.controller.dispose();
  }
});
