import assert from "node:assert/strict";
import test from "node:test";
import { ProjectConversationController } from "../src/workbench/ProjectConversationController.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settled() {
  for (let index = 0; index < 8; index++) await tick();
}
async function waitFor(condition) {
  const deadline = Date.now() + 1000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(condition(), "expected project chat transition");
}
const gate = () => {
  let resolve;
  return {
    promise: new Promise((done) => {
      resolve = done;
    }),
    resolve,
  };
};
const workspace = "workspace-project-" + "a".repeat(64);
const nextWorkspace = "workspace-project-" + "b".repeat(64);
const details = (projectId) => ({ project: { projectId, state: "active" } });
const binding = (
  projectId,
  workspaceId = workspace,
  threadId = "project-chat",
) => ({
  bindingId: "binding-" + threadId,
  projectId,
  workspaceId,
  threadId,
  revision: 1,
  state: "active",
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "54.0.0",
    packageDigest: "sha256:" + "a".repeat(64),
    selectionRevision: 5,
  },
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
});
function fixture(
  client,
  { resolveWorkspace, automaticOpen = true, projectId = "project-one" } = {},
) {
  let physical = false;
  const controller = new ProjectConversationController({
    client,
    physicalWritesPending: () => physical,
    resolveWorkspace,
  });
  controller.setAutomaticOpen(automaticOpen);
  controller.setProject(details(projectId));
  controller.setReady(true);
  return {
    controller,
    physical(value) {
      physical = value;
      controller.refreshWriteActivity();
    },
  };
}

test("entering a project restores its actual active chat without creating, resolving an ambient workspace, or executing", async () => {
  const opens = [];
  const current = binding("project-one", "saved-project-workspace");
  const f = fixture(
    {
      async listConversations() {
        return { bindings: [current], nextThreadId: null };
      },
      async openConversation(input) {
        opens.push(input);
        return { binding: current };
      },
      async createConversation() {
        assert.fail("existing project chat must be restored");
      },
    },
    {
      resolveWorkspace() {
        assert.fail("existing binding already identifies its workspace");
      },
    },
  );
  try {
    await settled();
    assert.deepEqual(opens, [
      { projectId: "project-one", threadId: "project-chat" },
    ]);
    assert.equal(f.controller.getSnapshot().openedThreadId, "project-chat");
    f.controller.setProject(details("project-one"));
    f.controller.setWorkspace({ workspaceId: null, name: null });
    f.controller.refreshWriteActivity();
    await settled();
    assert.equal(
      opens.length,
      1,
      "stage changes and Host updates do not reopen the chat",
    );
  } finally {
    f.controller.dispose();
  }
});

test("first project chat uses the resolved project workspace and identical idempotency identity across mounts", async () => {
  const creates = [],
    opens = [],
    receipts = new Map();
  const client = {
    async listConversations() {
      return { bindings: [], nextThreadId: null };
    },
    async createConversation(input) {
      creates.push(structuredClone(input));
      const found = receipts.get(input.idempotencyKey);
      const saved = found ?? binding(input.projectId, input.workspaceId);
      receipts.set(input.idempotencyKey, saved);
      return { disposition: found ? "replayed" : "committed", binding: saved };
    },
    async openConversation(input) {
      opens.push(input);
      return { binding: [...receipts.values()][0] };
    },
  };
  const resolveWorkspace = async ({ projectId }) => ({
    projectId,
    workspaceId: workspace,
  });
  const left = fixture(client, { resolveWorkspace });
  const remounted = fixture(client, { resolveWorkspace });
  try {
    await waitFor(() => opens.length === 2);
    assert.equal(
      creates.length,
      2,
      "each authority sends its own qualified request",
    );
    assert.deepEqual(creates[0], creates[1]);
    assert.equal(creates[0].workspaceId, workspace);
    assert.match(creates[0].idempotencyKey, /^project-chat-v1-[a-f0-9]{64}$/u);
    assert.equal(receipts.size, 1, "server replay prevents duplicate Threads");
    assert.equal(opens.length, 2);
    for (const f of [left, remounted]) {
      f.controller.setWorkspace({
        workspaceId: "unrelated-selected-workspace",
        name: "普通任务",
      });
      f.controller.setProject(details("project-one"));
      f.controller.refreshWriteActivity();
    }
    await settled();
    assert.equal(creates.length, 2);
    assert.equal(opens.length, 2);
  } finally {
    left.controller.dispose();
    remounted.controller.dispose();
  }
});

test("right result page never competes with navigation for central chat", async () => {
  const f = fixture(
    {
      async listConversations() {
        return { bindings: [binding("project-one")], nextThreadId: null };
      },
      async openConversation() {
        assert.fail("right results must not move central chat");
      },
      async createConversation() {
        assert.fail("right results must not create a chat");
      },
    },
    {
      automaticOpen: false,
      resolveWorkspace() {
        assert.fail("right results must not provision");
      },
    },
  );
  try {
    await settled();
    assert.equal(f.controller.getSnapshot().openedThreadId, null);
  } finally {
    f.controller.dispose();
  }
});

test("workspace resolution fails closed without null fallback or automatic retries", async () => {
  let targets = 0,
    creates = 0;
  const f = fixture(
    {
      async listConversations() {
        return { bindings: [], nextThreadId: null };
      },
      async createConversation(input) {
        ++creates;
        return {
          disposition: "committed",
          binding: binding(input.projectId, input.workspaceId),
        };
      },
      async openConversation() {
        return { binding: binding("project-one") };
      },
    },
    {
      async resolveWorkspace({ projectId }) {
        if (++targets === 1) throw new Error("workspace_target_unavailable");
        return { projectId, workspaceId: workspace };
      },
    },
  );
  try {
    await settled();
    assert.equal(targets, 1);
    assert.equal(creates, 0);
    assert.match(f.controller.getSnapshot().error, /工作空间/u);
    f.controller.setWorkspace({ workspaceId: null, name: null });
    f.controller.refreshWriteActivity();
    await f.controller.refresh();
    await settled();
    assert.equal(targets, 1);
    assert.equal(creates, 0);
    await f.controller.reconnect();
    await settled();
    assert.equal(targets, 2);
    assert.equal(creates, 1);
    assert.equal(f.controller.getSnapshot().openedThreadId, "project-chat");
  } finally {
    f.controller.dispose();
  }
});

test("lost creation ACK retains the resolved original request and only explicit reconnect replays it", async () => {
  const creates = [],
    saved = binding("project-one");
  let targets = 0;
  const f = fixture(
    {
      async listConversations() {
        return { bindings: creates.length ? [saved] : [], nextThreadId: null };
      },
      async createConversation(input) {
        creates.push(structuredClone(input));
        if (creates.length === 1) throw new Error("lost_ack");
        return { disposition: "replayed", binding: saved };
      },
      async openConversation() {
        return { binding: saved };
      },
    },
    {
      async resolveWorkspace({ projectId }) {
        ++targets;
        return { projectId, workspaceId: workspace };
      },
    },
  );
  try {
    await settled();
    assert.equal(creates.length, 1);
    assert.ok(f.controller.getSnapshot().pendingCreation);
    f.controller.setWorkspace({
      workspaceId: nextWorkspace,
      name: "错误的环境提示",
    });
    f.controller.refreshWriteActivity();
    await f.controller.refresh();
    await settled();
    assert.equal(creates.length, 1);
    assert.equal(f.controller.getSnapshot().openedThreadId, null);
    await f.controller.retryCreation();
    assert.deepEqual(creates[1], creates[0]);
    assert.equal(targets, 1, "recovery cannot retarget a dispatched write");
    assert.equal(f.controller.getSnapshot().openedThreadId, saved.threadId);
  } finally {
    f.controller.dispose();
  }
});

test("late workspace lookup from a previous project cannot create or move the new project chat", async () => {
  const delayed = gate(),
    creates = [],
    opens = [];
  const f = fixture(
    {
      async listConversations() {
        return { bindings: [], nextThreadId: null };
      },
      async createConversation(input) {
        creates.push(input);
        return {
          disposition: "committed",
          binding: binding(input.projectId, input.workspaceId),
        };
      },
      async openConversation(input) {
        opens.push(input);
        return { binding: binding(input.projectId, nextWorkspace) };
      },
    },
    {
      async resolveWorkspace({ projectId }) {
        return projectId === "project-one"
          ? delayed.promise
          : { projectId, workspaceId: nextWorkspace };
      },
    },
  );
  try {
    await settled();
    f.controller.setProject(details("project-two"));
    await settled();
    delayed.resolve({ projectId: "project-one", workspaceId: workspace });
    await settled();
    assert.deepEqual(
      creates.map((input) => input.projectId),
      ["project-two"],
    );
    assert.deepEqual(opens, [
      { projectId: "project-two", threadId: "project-chat" },
    ]);
    assert.equal(f.controller.getSnapshot().projectId, "project-two");
    assert.equal(f.controller.getSnapshot().openedThreadId, "project-chat");
  } finally {
    f.controller.dispose();
  }
});

test("switching away from unknown creation isolates pending state and restores the original retry on return", async () => {
  const delayed = gate(),
    creates = [],
    saved = new Map();
  const f = fixture(
    {
      async listConversations({ projectId }) {
        return {
          bindings: saved.has(projectId) ? [saved.get(projectId)] : [],
          nextThreadId: null,
        };
      },
      async createConversation(input) {
        creates.push(structuredClone(input));
        const value = binding(
          input.projectId,
          input.workspaceId,
          "chat-" + input.projectId,
        );
        saved.set(input.projectId, value);
        return creates.length === 1
          ? delayed.promise
          : { disposition: "replayed", binding: value };
      },
      async openConversation({ projectId }) {
        return { binding: saved.get(projectId) };
      },
    },
    {
      async resolveWorkspace({ projectId }) {
        return {
          projectId,
          workspaceId: projectId === "project-one" ? workspace : nextWorkspace,
        };
      },
    },
  );
  try {
    await settled();
    assert.equal(creates.length, 1);
    f.controller.setProject(details("project-two"));
    await settled();
    assert.equal(creates.length, 2);
    assert.equal(f.controller.getSnapshot().pendingCreation, null);
    delayed.resolve({
      disposition: "committed",
      binding: saved.get("project-one"),
    });
    await settled();
    assert.equal(f.controller.getSnapshot().openedThreadId, "chat-project-two");
    f.controller.setProject(details("project-one"));
    await settled();
    assert.deepEqual(f.controller.getSnapshot().pendingCreation, creates[0]);
    assert.equal(creates.length, 2);
    await f.controller.retryCreation();
    assert.deepEqual(creates[2], creates[0]);
    assert.equal(f.controller.getSnapshot().openedThreadId, "chat-project-one");
  } finally {
    f.controller.dispose();
  }
});

test("expired source is refreshed once through the existing authority and opens the same chat and workspace", async () => {
  const opens = [],
    refreshes = [];
  let saved = binding("project-one", "original-project-workspace"),
    lost = true;
  const f = fixture(
    {
      async listConversations() {
        return { bindings: [saved], nextThreadId: null };
      },
      async openConversation(input) {
        opens.push(input);
        if (saved.revision === 1)
          throw new Error("project_conversation_source_mismatch");
        return { binding: saved };
      },
      async refreshSource(input) {
        refreshes.push(structuredClone(input));
        saved = {
          ...saved,
          revision: 2,
          source: { ...saved.source, selectionRevision: 6, version: "55.0.0" },
        };
        if (lost) {
          lost = false;
          throw new Error("lost_refresh_ack");
        }
        return { disposition: "replayed", binding: saved };
      },
    },
    {
      resolveWorkspace() {
        assert.fail("source update must keep the original workspace");
      },
    },
  );
  try {
    await settled();
    assert.equal(refreshes.length, 1);
    assert.equal(opens.length, 1);
    assert.ok(f.controller.getSnapshot().pendingSourceRefresh);
    f.controller.setWorkspace({ workspaceId: nextWorkspace, name: "普通任务" });
    f.controller.refreshWriteActivity();
    await settled();
    assert.equal(refreshes.length, 1);
    await f.controller.retrySourceRefresh();
    assert.deepEqual(refreshes[1], refreshes[0]);
    assert.equal(
      f.controller.getSnapshot().bindings[0].workspaceId,
      "original-project-workspace",
    );
    assert.equal(f.controller.getSnapshot().openedThreadId, "project-chat");
  } finally {
    f.controller.dispose();
  }
});

test("a successful project chat reconnects once after Host readiness returns and never starts a model turn", async () => {
  const saved = binding("project-one"),
    opens = [];
  const f = fixture({
    async listConversations() {
      return { bindings: [saved], nextThreadId: null };
    },
    async openConversation(input) {
      opens.push(input);
      return { binding: saved };
    },
    async createConversation() {
      assert.fail("reconnect restores the same chat");
    },
  });
  try {
    await settled();
    f.controller.setReady(false);
    assert.equal(f.controller.getSnapshot().openedThreadId, null);
    f.controller.setReady(true);
    await settled();
    assert.equal(opens.length, 2);
    await f.controller.refresh();
    f.controller.refreshWriteActivity();
    await settled();
    assert.equal(opens.length, 2);
  } finally {
    f.controller.dispose();
  }
});

test("archived projects automatically restore existing valid chat without creating or refreshing source", async () => {
  const saved = binding("project-one"),
    opens = [];
  const f = fixture(
    {
      async listConversations() {
        return { bindings: [saved], nextThreadId: null };
      },
      async openConversation(input) {
        opens.push(input);
        return { binding: saved };
      },
      async createConversation() {
        assert.fail("archived project cannot create a chat");
      },
      async refreshSource() {
        assert.fail("archived project cannot write source");
      },
    },
    {
      resolveWorkspace() {
        assert.fail("archived project cannot resolve a creation target");
      },
    },
  );
  f.controller.setProject({
    project: { projectId: "project-one", state: "archived" },
  });
  try {
    await settled();
    assert.equal(opens.length, 1);
    assert.equal(f.controller.getSnapshot().openedThreadId, saved.threadId);
    assert.equal(f.controller.canCreate, false);
    assert.equal(f.controller.canRefreshSource, false);
  } finally {
    f.controller.dispose();
  }
});

test("archived source mismatch offers restore instructions without an automatic refresh write", async () => {
  const f = fixture({
    async listConversations() {
      return { bindings: [binding("project-one")], nextThreadId: null };
    },
    async openConversation() {
      throw new Error("project_conversation_source_mismatch");
    },
    async refreshSource() {
      assert.fail("restore project before changing source");
    },
    async createConversation() {
      assert.fail("restore project before creating chat");
    },
  });
  f.controller.setProject({
    project: { projectId: "project-one", state: "archived" },
  });
  try {
    await settled();
    assert.match(f.controller.getSnapshot().error, /恢复项目后/u);
    assert.equal(f.controller.getSnapshot().pendingSourceRefresh, null);
  } finally {
    f.controller.dispose();
  }
});

test("empty archived project and archival during workspace resolution never dispatch creation", async () => {
  const deferred = gate();
  let targets = 0;
  const f = fixture(
    {
      async listConversations() {
        return { bindings: [], nextThreadId: null };
      },
      async createConversation() {
        assert.fail("archival must prevent a new chat");
      },
    },
    {
      async resolveWorkspace() {
        ++targets;
        return deferred.promise;
      },
    },
  );
  try {
    await settled();
    assert.equal(targets, 1);
    f.controller.setProject({
      project: { projectId: "project-one", state: "archived" },
    });
    deferred.resolve({ projectId: "project-one", workspaceId: workspace });
    await settled();
    assert.equal(f.controller.getSnapshot().pendingCreation, null);
    f.controller.setProject({
      project: { projectId: "project-two", state: "archived" },
    });
    await settled();
    assert.equal(targets, 1);
    assert.match(f.controller.getSnapshot().notice, /暂无可恢复/u);
  } finally {
    f.controller.dispose();
  }
});
