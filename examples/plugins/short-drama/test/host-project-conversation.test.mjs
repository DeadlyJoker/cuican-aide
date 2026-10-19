import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { sourceUiDefinition } from "./source-ui.test-support.mjs";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import {
  metadataService,
  persistentProps,
} from "./persistent-ui.test-support.mjs";

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "54.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const definition =
  process.env.CREWON_SHORT_DRAMA_TEST_SOURCE_UI === "1"
    ? await sourceUiDefinition()
    : (await import(pathToFileURL(join(directory, "ui.mjs")).href)).default;
after(async () => browser.happyDOM.close());
const workspaceId = "workspace-project-" + "a".repeat(64);
function projectChatService({
  creationContextVersion,
  workspaceMode = "plugin-owned-explicit",
  contextFailure = null,
} = {}) {
  const base = metadataService();
  const projectId = base.create("来信", "快递员收到过去寄来的信。").project
    .projectId;
  const calls = [],
    bindings = new Map(),
    receipts = new Map();
  let loseAck = false,
    targetsAvailable = true;
  return {
    projectId,
    bindings,
    calls,
    loseNextAck() {
      loseAck = true;
    },
    setTargetsAvailable(value) {
      targetsAvailable = value;
    },
    props(surface, stage = "overview", version = creationContextVersion) {
      const props = persistentProps(true);
      return {
        ...props,
        data: {
          ...props.data,
          projectConversationContext: {
            creationWorkspaceId: null,
            creationWorkspaceName: null,
          },
          hostPresentation: {
            surface,
            context: { projectId, stage },
            ...(version ? { projectConversationCreationContext: version } : {}),
          },
        },
      };
    },
    services: {
      async invoke(action, input, options) {
        calls.push({ action, input: structuredClone(input) });
        if (
          action === "crewon.project-workspace-target.v1.getCreationContext"
        ) {
          assert.deepEqual(input, {});
          if (contextFailure) throw contextFailure;
          return {
            schemaVersion: "crewon.project-conversation-creation-context.v1",
            workspaceMode,
          };
        }
        if (action === "crewon.project-workspace-target.v1.resolveTarget") {
          assert.deepEqual(input, { projectId });
          if (!targetsAvailable)
            throw new Error("project_workspace_target_unavailable");
          return { projectId, workspaceId };
        }
        if (action.startsWith("crewon.project-conversations.v1.")) {
          assert.equal(input.projectId, projectId);
          if (action.endsWith(".listConversations"))
            return { bindings: [...bindings.values()], nextThreadId: null };
          if (action.endsWith(".openConversation"))
            return { binding: bindings.get(input.threadId) };
          assert.equal(
            action,
            "crewon.project-conversations.v1.createConversation",
          );
          const resolvedWorkspace =
            workspaceMode === "legacy-nullable" ? null : workspaceId;
          assert.equal(input.workspaceId, resolvedWorkspace);
          const previous = receipts.get(input.idempotencyKey);
          if (previous) assert.deepEqual(previous.input, input);
          const value = previous?.binding ?? {
            bindingId: "host-project-binding",
            projectId,
            workspaceId: resolvedWorkspace,
            threadId: "host-project-chat",
            revision: 1,
            state: "active",
            source: {
              pluginId: "crewon.short-drama",
              publisherId: "example.publisher",
              version,
              packageDigest: "sha256:" + "a".repeat(64),
              selectionRevision: 5,
            },
            createdAt: "2026-10-14T00:00:00.000Z",
            updatedAt: "2026-10-14T00:00:00.000Z",
          };
          bindings.set(value.threadId, value);
          receipts.set(input.idempotencyKey, {
            input: structuredClone(input),
            binding: value,
          });
          if (loseAck) {
            loseAck = false;
            throw new Error("lost_creation_ack");
          }
          return {
            disposition: previous ? "replayed" : "committed",
            binding: value,
          };
        }
        if (action.startsWith("crewon.plugin-navigation"))
          throw new Error("navigation_requires_host_update");
        return base.services.invoke(action, input, options);
      },
    },
  };
}
async function waitFor(condition) {
  for (let iteration = 0; iteration < 20 && !condition(); iteration++)
    await settle();
  assert.ok(condition(), "expected project chat transition");
}
const callsTo = (service, method) =>
  service.calls.filter((call) => call.action.endsWith("." + method));

test("entering a project opens shared chat from the left navigation once while right results remain passive", async () => {
  const service = projectChatService();
  let left = fixture(definition, {
    props: service.props("sidebar"),
    services: service.services,
  });
  const right = fixture(definition, {
    props: service.props("workbench"),
    services: service.services,
  });
  try {
    await waitFor(() => callsTo(service, "openConversation").length === 1);
    assert.equal(callsTo(service, "resolveTarget").length, 1);
    assert.equal(callsTo(service, "createConversation").length, 1);
    assert.equal(service.bindings.size, 1);
    assert.match(
      callsTo(service, "createConversation")[0].input.idempotencyKey,
      /^project-chat-v1-[a-f0-9]{64}$/u,
    );
    assert.ok(left.container.textContent.includes("项目对话已就绪"));
    assert.equal(
      [...left.container.querySelectorAll("button")].some((b) =>
        /开始与 Agent 对话|继续与 Agent 对话/.test(b.textContent),
      ),
      false,
    );
    assert.equal(
      right.container.querySelector('[aria-label="项目 Agent 对话"]'),
      null,
    );
    const markup = left.container
      .querySelector('[aria-label="项目 Agent 对话"]')
      .outerHTML.replace(
        /<p class="detail-note">[^<]*2026[^<]*<\/p>/gu,
        '<p class="detail-note">CREATED_AT</p>',
      );
    const snapshot = new URL(
      "./snapshots/host-project-conversation.html",
      import.meta.url,
    );
    if (process.env.CREWON_UPDATE_CONVERSATION_SNAPSHOTS === "1")
      await writeFile(snapshot, markup + "\n");
    assert.equal(markup, (await readFile(snapshot, "utf8")).trimEnd());
    left.instance.update(service.props("sidebar", "characters"));
    right.instance.update(service.props("workbench", "characters"));
    await settle();
    assert.equal(
      callsTo(service, "openConversation").length,
      1,
      "stage updates do not execute or move the conversation",
    );
    await left.dispose();
    left = fixture(definition, {
      props: service.props("sidebar", "characters"),
      services: service.services,
    });
    await waitFor(() => callsTo(service, "openConversation").length === 2);
    assert.equal(callsTo(service, "createConversation").length, 1);
    assert.equal(callsTo(service, "resolveTarget").length, 1);
    assert.equal(
      service.calls.some((call) =>
        /startStage|generate|text-plans.v1.start|crewon.tasks./u.test(
          call.action,
        ),
      ),
      false,
    );
  } finally {
    await left.dispose();
    await right.dispose();
  }
});

test("unknown automatic creation shows one clear recovery action and replays the original scoped request", async () => {
  const service = projectChatService();
  service.loseNextAck();
  const f = fixture(definition, {
    props: service.props("sidebar"),
    services: service.services,
  });
  try {
    await waitFor(() => Boolean(f.container.querySelector('[role="alert"]')));
    const original = callsTo(service, "createConversation")[0].input;
    assert.equal(callsTo(service, "openConversation").length, 0);
    assert.equal(f.button("新建项目对话").disabled, true);
    await settle();
    f.instance.update(service.props("sidebar", "script"));
    await settle();
    assert.equal(callsTo(service, "createConversation").length, 1);
    assert.equal(
      [...f.container.querySelectorAll("button")].filter(
        (b) => b.textContent.trim() === "重新连接",
      ).length,
      1,
    );
    await f.click(f.button("重新连接"));
    await waitFor(() => callsTo(service, "openConversation").length === 1);
    assert.deepEqual(callsTo(service, "createConversation")[1].input, original);
    assert.equal(callsTo(service, "resolveTarget").length, 1);
    assert.equal(service.bindings.size, 1);
    assert.equal(f.container.querySelector('[role="alert"]'), null);
  } finally {
    await f.dispose();
  }
});

test("unavailable workspace resolution never creates a null-workspace chat or auto retries", async () => {
  const service = projectChatService();
  service.setTargetsAvailable(false);
  const f = fixture(definition, {
    props: service.props("sidebar"),
    services: service.services,
  });
  try {
    await waitFor(() => Boolean(f.container.querySelector('[role="alert"]')));
    await settle();
    assert.equal(callsTo(service, "resolveTarget").length, 1);
    assert.equal(callsTo(service, "createConversation").length, 0);
    assert.equal(callsTo(service, "openConversation").length, 0);
    service.setTargetsAvailable(true);
    await f.click(f.button("重新连接"));
    await waitFor(() => callsTo(service, "openConversation").length === 1);
    assert.equal(callsTo(service, "resolveTarget").length, 2);
    assert.equal(callsTo(service, "createConversation").length, 1);
  } finally {
    await f.dispose();
  }
});

test("new Host explicitly permits legacy nullable creation and right results never start execution", async () => {
  const service = projectChatService({
    creationContextVersion: "v1",
    workspaceMode: "legacy-nullable",
  });
  const left = fixture(definition, {
    props: service.props("sidebar"),
    services: service.services,
  });
  const right = fixture(definition, {
    props: service.props("workbench"),
    services: service.services,
  });
  try {
    await waitFor(() => callsTo(service, "openConversation").length === 1);
    assert.equal(callsTo(service, "getCreationContext").length, 1);
    assert.equal(callsTo(service, "resolveTarget").length, 0);
    assert.equal(callsTo(service, "createConversation").length, 1);
    assert.equal(
      callsTo(service, "createConversation")[0].input.workspaceId,
      null,
    );
    assert.equal(service.bindings.size, 1);
    assert.ok(left.container.textContent.includes("项目对话已就绪"));
    assert.equal(
      right.container.querySelector('[aria-label="项目 Agent 对话"]'),
      null,
    );
    assert.equal(
      service.calls.some((c) =>
        /startStage|generate|upload|createProject/.test(c.action),
      ),
      false,
    );
  } finally {
    await left.dispose();
    await right.dispose();
  }
});

test("new owned Host retains its exact explicit workspace and never creates a legacy chat", async () => {
  const service = projectChatService({ creationContextVersion: "v1" });
  const f = fixture(definition, {
    props: service.props("sidebar"),
    services: service.services,
  });
  try {
    await waitFor(() => callsTo(service, "openConversation").length === 1);
    assert.equal(callsTo(service, "getCreationContext").length, 1);
    assert.equal(callsTo(service, "resolveTarget").length, 1);
    assert.equal(
      callsTo(service, "createConversation")[0].input.workspaceId,
      workspaceId,
    );
  } finally {
    await f.dispose();
  }
});

test("denied creation context never falls back, and a legacy unknown ACK replays only its original body", async () => {
  const denied = projectChatService({
    creationContextVersion: "v1",
    contextFailure: new Error("plugin_ui_action_denied"),
  });
  const blocked = fixture(definition, {
    props: denied.props("sidebar"),
    services: denied.services,
  });
  try {
    await waitFor(() =>
      Boolean(blocked.container.querySelector('[role="alert"]')),
    );
    assert.equal(callsTo(denied, "getCreationContext").length, 1);
    assert.equal(callsTo(denied, "resolveTarget").length, 0);
    assert.equal(callsTo(denied, "createConversation").length, 0);
    await settle();
    assert.equal(callsTo(denied, "getCreationContext").length, 1);
  } finally {
    await blocked.dispose();
  }
  const service = projectChatService({
    creationContextVersion: "v1",
    workspaceMode: "legacy-nullable",
  });
  service.loseNextAck();
  const f = fixture(definition, {
    props: service.props("sidebar"),
    services: service.services,
  });
  try {
    await waitFor(() => Boolean(f.container.querySelector('[role="alert"]')));
    const original = callsTo(service, "createConversation")[0].input;
    assert.equal(original.workspaceId, null);
    f.instance.update(service.props("sidebar", "script", null));
    await settle();
    assert.equal(callsTo(service, "createConversation").length, 1);
    await f.click(f.button("重新连接"));
    await waitFor(() => callsTo(service, "openConversation").length === 1);
    assert.deepEqual(callsTo(service, "createConversation")[1].input, original);
    assert.equal(callsTo(service, "getCreationContext").length, 1);
    assert.equal(callsTo(service, "resolveTarget").length, 0);
    assert.equal(service.bindings.size, 1);
  } finally {
    await f.dispose();
  }
});

test("the resolver reads the current Host marker when a passive page becomes navigation owner", async () => {
  const service = projectChatService({ workspaceMode: "legacy-nullable" });
  const f = fixture(definition, {
    props: service.props("workbench"),
    services: service.services,
  });
  try {
    await settle();
    assert.equal(callsTo(service, "getCreationContext").length, 0);
    assert.equal(callsTo(service, "createConversation").length, 0);
    f.instance.update(service.props("sidebar", "overview", "v1"));
    await waitFor(() => callsTo(service, "openConversation").length === 1);
    assert.equal(callsTo(service, "getCreationContext").length, 1);
    assert.equal(callsTo(service, "resolveTarget").length, 0);
    assert.equal(
      callsTo(service, "createConversation")[0].input.workspaceId,
      null,
    );
  } finally {
    await f.dispose();
  }
});
