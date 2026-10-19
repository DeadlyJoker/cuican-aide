// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import { deferred, flush, uiLease } from "./pluginUiLoader.test-support";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import {
  createProjectWorkspaceChangeObserver,
  subscribeProjectWorkspaceChanges,
} from "./projectWorkspaceChanges";

const lease = uiLease();
const module: ControlPluginUiModule = {
  key: "foundation",
  mountKey: "foundation",
  title: "Foundation",
  contributionId: "workbench",
  plugin: controlUiItem(lease),
};
const binding: PublicProjectConversationBinding = {
  bindingId: "binding",
  projectId: "project",
  threadId: "thread",
  workspaceId: null,
  revision: 1,
  state: "active",
  source: {
    pluginId: lease.descriptor.pluginId,
    publisherId: lease.descriptor.publisherId,
    version: lease.descriptor.version,
    packageDigest: lease.packageDigest,
    selectionRevision: lease.selectionRevision,
  },
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
};
const tool = (
  id = "save",
): Extract<ThreadItem, { type: "dynamicToolCall" }> => ({
  type: "dynamicToolCall",
  id,
  namespace: null,
  tool: "example_workbench__foundation_proposal_save",
  arguments: { projectId: "project" },
  status: "completed",
  success: true,
  contentItems: [
    {
      type: "inputText",
      text: "This output is never projected into the proposal.",
    },
  ],
  durationMs: 1,
});

it("successful asset saves and a terminal fallback refresh only the captured source without replaying mutations", async () => {
  const wire = controlUiClient(() => controlUiResponse({ binding }));
  const observer = createProjectWorkspaceChangeObserver(wire.client);
  const assets = vi.fn(),
    texts = vi.fn(),
    foreign = vi.fn();
  const off = [
    subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "assets",
      assets,
    ),
    subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "texts",
      texts,
    ),
    subscribeProjectWorkspaceChanges(
      wire.client,
      "other",
      module,
      "assets",
      foreign,
    ),
  ];
  try {
    const saved = {
      ...tool("asset-write"),
      tool: "example_workbench__asset_save",
    };
    observer.tool("thread", "asset-run", { ...saved, success: false });
    await flush();
    expect(wire.fetch).not.toHaveBeenCalled();
    observer.tool("thread", "asset-run", saved);
    await flush();
    observer.tool("thread", "asset-run", saved);
    await flush();
    expect(assets).toHaveBeenCalledTimes(1);
    expect(texts).not.toHaveBeenCalled();
    observer.terminal("thread", "asset-run");
    await flush();
    expect(assets).toHaveBeenCalledTimes(2);
    expect(texts).toHaveBeenCalledTimes(1);
    expect(foreign).not.toHaveBeenCalled();
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    expect(
      wire.fetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  } finally {
    observer.close();
    off.forEach((close) => close());
  }
});

it("scopes by client/project/full source and dedupes tool replay with one terminal fallback", async () => {
  const wire = controlUiClient(() => controlUiResponse({ binding }));
  const observer = createProjectWorkspaceChangeObserver(wire.client);
  const matching = vi.fn(),
    wrongProject = vi.fn(),
    wrongSource = vi.fn(),
    wrongClient = vi.fn();
  const foreign = controlUiClient(() => controlUiResponse({ binding }));
  const off = [
    subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "foundation",
      matching,
    ),
    subscribeProjectWorkspaceChanges(
      wire.client,
      "other-project",
      module,
      "foundation",
      wrongProject,
    ),
    subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      {
        ...module,
        plugin: { ...module.plugin, packageDigest: `sha256:${"f".repeat(64)}` },
      },
      "foundation",
      wrongSource,
    ),
    subscribeProjectWorkspaceChanges(
      foreign.client,
      "project",
      module,
      "foundation",
      wrongClient,
    ),
  ];
  try {
    observer.tool("thread", "run", tool());
    await flush();
    observer.tool("thread", "run", tool());
    observer.terminal("thread", "run");
    await flush();
    expect(matching).toHaveBeenCalledTimes(2);
    expect(wrongProject).not.toHaveBeenCalled();
    expect(wrongSource).not.toHaveBeenCalled();
    expect(wrongClient).not.toHaveBeenCalled();
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    expect(wire.fetch.mock.calls[0]![1]?.method).toBe("GET");
  } finally {
    observer.close();
    off.forEach((close) => close());
  }
});

it("gated binding reads retain foundation and text areas separately, then terminal supplies each area once", async () => {
  const gate = deferred<Response>();
  const wire = controlUiClient(() =>
    wire.fetch.mock.calls.length === 1
      ? gate.promise
      : controlUiResponse({ binding }),
  );
  const observer = createProjectWorkspaceChangeObserver(wire.client);
  const foundation = vi.fn(),
    texts = vi.fn();
  const off = [
    subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "foundation",
      foundation,
    ),
    subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "texts",
      texts,
    ),
  ];
  try {
    observer.tool("thread", "run", tool("proposal"));
    observer.tool("thread", "run", {
      ...tool("script"),
      tool: "example_workbench__script_save",
    });
    observer.terminal("thread", "run");
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    gate.resolve(controlUiResponse({ binding }));
    await flush();
    expect(wire.fetch).toHaveBeenCalledTimes(3);
    expect(foundation).toHaveBeenCalledTimes(2);
    expect(texts).toHaveBeenCalledTimes(2);
    observer.terminal("thread", "run");
    await flush();
    expect(wire.fetch).toHaveBeenCalledTimes(3);
  } finally {
    gate.resolve(controlUiResponse({ binding }));
    observer.close();
    off.forEach((close) => close());
  }
});

it("does not deliver a different plugin's qualified operation through the current binding", async () => {
  const wire = controlUiClient(() => controlUiResponse({ binding }));
  const observer = createProjectWorkspaceChangeObserver(wire.client);
  const listener = vi.fn(),
    off = subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "foundation",
      listener,
    );
  try {
    observer.tool("thread", "run", {
      ...tool(),
      tool: "foreign_plugin__foundation_proposal_save",
    });
    await flush();
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  } finally {
    observer.close();
    off();
  }
});

it("does not deliver a late binding response after its runtime/session owner closes", async () => {
  const gate = deferred<Response>();
  const wire = controlUiClient(() => gate.promise);
  const observer = createProjectWorkspaceChangeObserver(wire.client);
  const listener = vi.fn(),
    off = subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "foundation",
      listener,
    );
  try {
    observer.tool("thread", "run", tool());
    observer.close();
    gate.resolve(controlUiResponse({ binding }));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve(controlUiResponse({ binding }));
    observer.close();
    off();
  }
});

it.each([
  { status: "inProgress" as const, success: null },
  { status: "failed" as const, success: false },
  { tool: "foundation_proposal_get" },
  { arguments: { projectId: "other-project" } },
])(
  "does not deliver an unrelated/unsuccessful tool hint: %j",
  async (patch) => {
    const wire = controlUiClient(() => controlUiResponse({ binding }));
    const observer = createProjectWorkspaceChangeObserver(wire.client);
    const listener = vi.fn();
    const off = subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "foundation",
      listener,
    );
    try {
      observer.tool("thread", "run", { ...tool(), ...patch });
      await flush();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      observer.close();
      off();
    }
  },
);

it.each([
  null,
  { ...binding, state: "revoked" as const },
  { ...binding, threadId: "foreign-thread" },
])("ignores unavailable or mismatched bindings", async (result) => {
  const wire = controlUiClient(() => controlUiResponse({ binding: result }));
  const observer = createProjectWorkspaceChangeObserver(wire.client);
  const listener = vi.fn(),
    off = subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "foundation",
      listener,
    );
  try {
    observer.terminal("thread", "run");
    await flush();
    expect(listener).not.toHaveBeenCalled();
  } finally {
    observer.close();
    off();
  }
});

it("terminal fallback can invalidate after a saved tool was omitted, with no subscriptions causing no GET", async () => {
  const wire = controlUiClient(() => controlUiResponse({ binding }));
  const observer = createProjectWorkspaceChangeObserver(wire.client);
  observer.terminal("thread", "unobserved");
  expect(wire.fetch).not.toHaveBeenCalled();
  const listener = vi.fn(),
    off = subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "foundation",
      listener,
    );
  try {
    observer.terminal("thread", "failed-or-canceled-after-commit");
    await flush();
    observer.terminal("thread", "failed-or-canceled-after-commit");
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  } finally {
    observer.close();
    off();
  }
});

it("coalesces in-flight saves and rejects late hints after owner withdrawal", async () => {
  const gate = deferred<Response>();
  const wire = controlUiClient(() =>
    wire.fetch.mock.calls.length === 1
      ? gate.promise
      : controlUiResponse({ binding }),
  );
  const observer = createProjectWorkspaceChangeObserver(wire.client);
  const listener = vi.fn(),
    off = subscribeProjectWorkspaceChanges(
      wire.client,
      "project",
      module,
      "foundation",
      listener,
    );
  try {
    observer.tool("thread", "run", tool("first"));
    observer.tool("thread", "run", tool("second"));
    observer.tool("thread", "run", tool("third"));
    gate.resolve(controlUiResponse({ binding }));
    await flush();
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2);
    observer.close();
    observer.terminal("thread", "late");
    await flush();
    expect(wire.fetch).toHaveBeenCalledTimes(2);
  } finally {
    observer.close();
    off();
  }
});
