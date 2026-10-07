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

test("expired source requires explicit refresh, reuses the original request after lost ACK, and opens the same workspace", async () => {
  let current = binding("test-project", "original-workspace"),
    lost = true;
  const writes = [],
    opens = [];
  const f = await fixture({
    async listConversations() {
      return { bindings: [current], nextThreadId: null };
    },
    async openConversation(input) {
      opens.push(input);
      if (current.revision === 1)
        throw Object.assign(new Error("source expired"), {
          code: "project_conversation_source_mismatch",
        });
      return { binding: current };
    },
    async refreshSource(input) {
      writes.push(structuredClone(input));
      current = {
        ...current,
        revision: 2,
        source: {
          ...current.source,
          version: "32.0.0",
          packageDigest: "sha256:" + "b".repeat(64),
          selectionRevision: 5,
        },
      };
      if (lost) {
        lost = false;
        throw new Error("lost_refresh_ack");
      }
      return { disposition: "replayed", binding: current };
    },
  });
  try {
    await f.controller.open("test-thread");
    assert.equal(writes.length, 0);
    assert.equal(
      f.controller.getSnapshot().sourceRefreshThreadId,
      "test-thread",
    );
    f.physical(true);
    await f.controller.refreshSourceAndOpen("test-thread");
    assert.equal(writes.length, 0);
    f.physical(false);
    await f.controller.refreshSourceAndOpen("test-thread");
    assert.equal(f.controller.locked, true);
    assert.equal(opens.length, 1);
    f.controller.setWorkspace({
      workspaceId: "unrelated-workspace",
      name: "Other",
    });
    await f.controller.open("test-thread");
    await f.controller.refreshSourceAndOpen("test-thread");
    assert.equal(opens.length, 1);
    assert.equal(writes.length, 1);
    await f.controller.retrySourceRefresh();
    assert.deepEqual(writes[1], writes[0]);
    assert.equal(writes[0].expectedBindingRevision, 1);
    assert.equal(f.controller.getSnapshot().pendingSourceRefresh, null);
    assert.equal(
      f.controller.getSnapshot().bindings[0].workspaceId,
      "original-workspace",
    );
    assert.deepEqual(opens.at(-1), {
      projectId: "test-project",
      threadId: "test-thread",
    });
  } finally {
    f.controller.dispose();
  }
});

test("withdrawal during source refresh keeps the original request and never opens a late reply", async () => {
  const gate = deferred(),
    calls = [];
  let opens = 0;
  const original = binding("test-project", "original-workspace");
  const updated = { ...original, revision: 2 };
  const f = await fixture({
    async listConversations() {
      return { bindings: [original], nextThreadId: null };
    },
    async openConversation() {
      ++opens;
      throw new Error("project_conversation_source_mismatch");
    },
    async refreshSource(input) {
      calls.push(input);
      return calls.length === 1
        ? gate.promise
        : { disposition: "replayed", binding: updated };
    },
  });
  try {
    await f.controller.open(original.threadId);
    const writing = f.controller.refreshSourceAndOpen(original.threadId);
    f.controller.setReady(false);
    gate.resolve({ disposition: "committed", binding: updated });
    await writing;
    assert.equal(opens, 1);
    assert.equal(
      f.controller.getSnapshot().pendingSourceRefresh.input,
      calls[0],
    );
    f.controller.setReady(true);
    await tick();
    await f.controller.retrySourceRefresh();
    assert.deepEqual(calls[1], calls[0]);
  } finally {
    f.controller.dispose();
  }
});

test("ordinary read failures never offer source refresh and a mismatched refresh receipt cannot navigate", async () => {
  let failure = "network_unavailable",
    opens = 0;
  const original = binding("test-project", "original-workspace");
  const f = await fixture({
    async listConversations() {
      return { bindings: [original], nextThreadId: null };
    },
    async openConversation() {
      ++opens;
      throw new Error(failure);
    },
    async refreshSource() {
      return {
        disposition: "committed",
        binding: { ...original, revision: 2, workspaceId: "foreign" },
      };
    },
  });
  try {
    await f.controller.open(original.threadId);
    assert.equal(f.controller.getSnapshot().sourceRefreshThreadId, null);
    failure = "project_conversation_source_mismatch";
    await f.controller.open(original.threadId);
    await f.controller.refreshSourceAndOpen(original.threadId);
    assert.equal(opens, 2);
    assert.ok(f.controller.getSnapshot().pendingSourceRefresh);
  } finally {
    f.controller.dispose();
  }
});
