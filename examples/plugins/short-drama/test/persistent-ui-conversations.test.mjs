import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import {
  metadataService,
  persistentProps,
} from "./persistent-ui.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.2";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
function props(workspaceId = "workspace-one", ready = true) {
  const value = persistentProps(ready);
  return {
    ...value,
    data: {
      ...value.data,
      projectConversationContext: {
        creationWorkspaceId: workspaceId,
        creationWorkspaceName: workspaceId === null ? null : "创作工作空间",
      },
    },
  };
}
/** Named public DTO Thread ledger, not production authorization or SQL. */
function conversations() {
  const base = metadataService(),
    bindings = new Map(),
    receipts = new Map(),
    calls = [];
  const projectId = base.create("来信", "快递员收到过去寄来的信。").project
    .projectId;
  let loseAck = false,
    available = true,
    serial = 0;
  return {
    base,
    projectId,
    bindings,
    calls,
    loseNextAck: () => {
      loseAck = true;
    },
    setAvailable: (value) => {
      available = value;
    },
    services: {
      async invoke(action, input, options) {
        if (!action.startsWith("crewon.project-conversations.v1."))
          return base.services.invoke(action, input, options);
        calls.push({ action, input: structuredClone(input) });
        if (!available) throw new Error("conversation_service_unavailable");
        assert.equal(input.projectId, projectId);
        if (action.endsWith(".listConversations"))
          return { bindings: [...bindings.values()], nextThreadId: null };
        if (action.endsWith(".openConversation"))
          return { binding: bindings.get(input.threadId) };
        assert.equal(
          action,
          "crewon.project-conversations.v1.createConversation",
        );
        const previous = receipts.get(input.idempotencyKey);
        if (previous) assert.deepEqual(previous.input, input);
        const binding = previous?.binding ?? {
          bindingId: `binding-${++serial}`,
          projectId,
          threadId: `project-thread-${serial}`,
          workspaceId: input.workspaceId,
          revision: 1,
          state: "active",
          source: {
            pluginId: "crewon.short-drama",
            publisherId: "example.publisher",
            version,
            packageDigest: "sha256:" + "a".repeat(64),
            selectionRevision: 1,
          },
          createdAt: "2026-10-06T00:00:00.000Z",
          updatedAt: "2026-10-06T00:00:00.000Z",
        };
        receipts.set(input.idempotencyKey, {
          input: structuredClone(input),
          binding,
        });
        bindings.set(binding.threadId, binding);
        if (loseAck) {
          loseAck = false;
          throw new Error("lost_creation_ack");
        }
        return { disposition: previous ? "replayed" : "committed", binding };
      },
    },
  };
}
async function open(service, incoming = props()) {
  const f = fixture(definition, {
    props: incoming,
    services: service.services,
  });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await settle();
  return f;
}
test("project conversation is created explicitly in the selected workspace and opened through the public service", async () => {
  const service = conversations(),
    f = await open(service);
  try {
    assert.equal(service.bindings.size, 0);
    assert.deepEqual(
      service.calls.map((call) => call.action),
      ["crewon.project-conversations.v1.listConversations"],
    );
    assert.match(f.container.textContent, /与 Agent 创作/u);
    await f.click(f.button("新建项目对话"));
    assert.equal(service.bindings.size, 1);
    assert.deepEqual(
      service.calls.find((call) => call.action.endsWith(".createConversation"))
        .input,
      {
        projectId: service.projectId,
        workspaceId: "workspace-one",
        title: null,
        idempotencyKey: service.calls.find((call) =>
          call.action.endsWith(".createConversation"),
        ).input.idempotencyKey,
      },
    );
    assert.equal(
      service.calls.filter((call) => call.action.endsWith(".openConversation"))
        .length,
      0,
      "creation does not silently leave the document",
    );
    await f.click(f.button("进入对话"));
    assert.deepEqual(service.calls.at(-1).input, {
      projectId: service.projectId,
      threadId: "project-thread-1",
    });
    assert.equal(
      service.calls.some((call) => call.action.endsWith(".startStage")),
      false,
    );
    await f.click(f.container.querySelectorAll(".stage-item")[1]);
    assert.equal(
      f.container.querySelector('[aria-label="项目 Agent 对话"]'),
      null,
    );
    await f.click(f.button("项目对话"));
    assert.ok(f.container.querySelector('[aria-label="项目 Agent 对话"]'));
  } finally {
    await f.dispose();
  }
});
test("lost conversation ACK retains the original workspace and key while Host hints and theme change", async () => {
  const service = conversations(),
    f = await open(service);
  try {
    service.loseNextAck();
    await f.click(f.button("新建项目对话"));
    const original = structuredClone(
      service.calls.find((call) => call.action.endsWith(".createConversation"))
        .input,
    );
    const next = props("workspace-two");
    next.theme = { ...next.theme, mode: "dark" };
    f.instance.update(next);
    await settle();
    assert.equal(f.button("新建项目对话").disabled, true);
    await f.click(f.button("重试原创建请求"));
    const creates = service.calls.filter((call) =>
      call.action.endsWith(".createConversation"),
    );
    assert.deepEqual(creates[1].input, original);
    assert.equal(service.bindings.size, 1);
    assert.equal(
      f.container.querySelector('[aria-label="AI 短剧工作台"]') !== null,
      true,
    );
  } finally {
    await f.dispose();
  }
});
test("cold remount reads existing project conversations without creating or executing another task", async () => {
  const service = conversations();
  let f = await open(service);
  try {
    await f.click(f.button("新建项目对话"));
    await f.dispose();
    f = await open(service);
    assert.equal(
      service.calls.filter((call) =>
        call.action.endsWith(".createConversation"),
      ).length,
      1,
    );
    assert.equal(f.button("进入对话").disabled, false);
    assert.equal(
      service.calls.some((call) => call.action.endsWith(".startStage")),
      false,
    );
    assert.equal(
      service.base.calls.some((call) =>
        call.action.startsWith("crewon.tasks."),
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("missing workspace hints and unavailable conversation service never fabricate a binding", async () => {
  const service = conversations();
  service.setAvailable(false);
  const f = await open(service, persistentProps(true));
  try {
    assert.equal(f.button("新建项目对话").disabled, true);
    assert.equal(service.bindings.size, 0);
    assert.match(f.container.textContent, /项目对话暂时无法读取/u);
    service.setAvailable(true);
    f.instance.update(props(null));
    await f.click(f.button("刷新项目对话"));
    await f.click(f.button("新建项目对话"));
    assert.equal([...service.bindings.values()][0].workspaceId, null);
  } finally {
    await f.dispose();
  }
});
