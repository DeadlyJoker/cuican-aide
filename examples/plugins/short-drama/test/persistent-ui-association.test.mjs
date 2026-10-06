import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { textService } from "./text-ui.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.2";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(() => browser.happyDOM.close());
function service() {
  const base = textService(),
    calls = [],
    bindings = new Map();
  const projectId = base.metadata.create("雨夜修复师", "三集都市悬疑。").project
    .projectId;
  let lose = false;
  return {
    projectId,
    calls,
    bindings,
    lose: () => {
      lose = true;
    },
    services: {
      async invoke(action, input, options) {
        calls.push({ action, input: structuredClone(input) });
        if (action === "crewon.project-conversations.v1.getBinding")
          return { binding: bindings.get(input.threadId) ?? null };
        if (action === "crewon.project-conversations.v1.listConversations")
          return { bindings: [...bindings.values()], nextThreadId: null };
        if (action === "crewon.project-conversation-association.v1.inspect")
          return {
            candidate: {
              threadId: input.threadId,
              threadRevision: 7,
              workspaceId: "original-directory",
            },
          };
        if (action === "crewon.project-conversation-association.v1.attach") {
          const at = "2026-10-06T00:00:00.000Z";
          const binding = {
            bindingId: "original-binding",
            projectId,
            threadId: input.threadId,
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
            createdAt: at,
            updatedAt: at,
          };
          bindings.set(binding.threadId, binding);
          if (lose) throw new Error("lost_association_ack");
          return { disposition: "committed", binding };
        }
        return base.services.invoke(action, input, options);
      },
    },
  };
}
async function mount(s, currentThread = "original-thread") {
  const props = persistentProps(true);
  if (currentThread !== undefined)
    props.data.projectConversationAssociationThreadId = currentThread;
  props.data.projectConversationContext = {
    creationWorkspaceId: "global-different-directory",
    creationWorkspaceName: "另一个工作空间",
  };
  const f = fixture(definition, { props, services: s.services });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  await settle();
  return f;
}
test("actual portable UI explicitly associates the current chat using its original directory and exposes it for plan selection without execution", async () => {
  const s = service(),
    f = await mount(s);
  try {
    assert.equal(s.bindings.size, 0);
    assert.equal(f.button("关联当前会话").disabled, false);
    assert.equal(
      s.calls.some((c) => c.action.endsWith(".attach")),
      false,
    );
    await f.click(f.button("关联当前会话"));
    const writes = s.calls.filter((c) => c.action.endsWith(".attach"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].input.threadId, "original-thread");
    assert.equal(writes[0].input.workspaceId, "original-directory");
    assert.match(f.container.textContent, /当前会话已关联此项目/u);
    const selector = f.container.querySelector(
      '[aria-label="计划使用的项目对话"]',
    );
    assert.ok([...selector.options].some((o) => o.value === "original-thread"));
    assert.equal(
      selector.value,
      "",
      "execution still requires explicit scope selection",
    );
    assert.equal(
      s.calls.some(
        (c) =>
          c.action.endsWith(".start") ||
          c.action.endsWith(".createConversation") ||
          c.action.endsWith(".startStage"),
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});
test("lost UI acknowledgement recovers by reading the existing relationship; reopening never resubmits or changes the original chat", async () => {
  const s = service();
  s.lose();
  const f = await mount(s);
  try {
    await f.click(f.button("关联当前会话"));
    assert.ok(f.button("重试原关联请求"));
    await f.click(f.button("重新读取关联"));
    assert.match(f.container.textContent, /当前会话已关联此项目/u);
    assert.equal(s.calls.filter((c) => c.action.endsWith(".attach")).length, 1);
  } finally {
    await f.dispose();
  }
  const cold = await mount(s);
  try {
    assert.match(cold.container.textContent, /当前会话已关联此项目/u);
    assert.equal(s.calls.filter((c) => c.action.endsWith(".attach")).length, 1);
  } finally {
    await cold.dispose();
  }
});
