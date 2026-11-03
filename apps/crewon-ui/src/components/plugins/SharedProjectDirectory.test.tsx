// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ControlApiClient } from "@crewon/control-client";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
import { sharedProjectDirectoryDefinition } from "./SharedProjectDirectory";

const api = vi.hoisted(() => ({
  list: vi.fn(async () => ({
    projects: [
      { projectId: "p1", title: "重录" },
      { projectId: "p2", title: "来信" },
    ],
    nextCursor: null,
  })),
  conversations: vi.fn(async () => ({
    bindings: [{ threadId: "t1", state: "active" }],
    nextThreadId: null,
  })),
  open: vi.fn(async () => ({})),
}));
vi.mock("@crewon/plugin-sdk/ui", async (original) => ({
  ...(await original<object>()),
  createPluginCreativeProjectClient: () => ({ listProjects: api.list }),
}));
vi.mock("@crewon/contracts/project-conversations", async (original) => ({
  ...(await original<object>()),
  createPluginProjectConversationsClient: () => ({
    listConversations: api.conversations,
    openConversation: api.open,
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("shared plugin project directory", () => {
  it("shows a retryable failure without presenting a failed read as an empty directory", async () => {
    api.list.mockRejectedValueOnce(new Error("unavailable"));
    const root = document.createElement("div");
    document.body.append(root);
    const definition = sharedProjectDirectoryDefinition({
      pluginId: "test.plugin",
      contributionId: "workbench",
      client: {} as ControlApiClient,
    });
    let instance: Awaited<ReturnType<typeof definition.mount>>;
    try {
      await act(async () => {
        instance = await definition.mount(
          root,
          {
            schemaVersion: "crewon.plugin-ui-props.v1",
            contributionId: "workbench",
            theme: { mode: "light", tokens: {} },
            data: { locale: "zh" },
          } as PluginUiProps,
          { invoke: vi.fn() },
        );
      });
      expect(root.textContent).toContain("目录暂不可用，请重试。");
      expect(root.textContent).not.toContain("暂无项目");
      await act(async () =>
        root
          .querySelector<HTMLButtonElement>('[aria-label="刷新项目"]')!
          .click(),
      );
      expect(root.textContent).toContain("重录");
      expect(root.textContent).not.toContain("目录暂不可用");
    } finally {
      await act(async () => instance?.dispose());
      root.remove();
    }
  });

  it("uses workspace rows and lazy conversation rows without the old duplicate cards", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const invoke = vi.fn(async () => null);
    const definition = sharedProjectDirectoryDefinition({
      pluginId: "test.plugin",
      contributionId: "workbench",
      client: {
        getThread: vi.fn(async () => ({ thread: { title: "创作对话" } })),
      } as unknown as ControlApiClient,
    });
    let instance: Awaited<ReturnType<typeof definition.mount>>;
    await act(async () => {
      instance = await definition.mount(
        root,
        {
          schemaVersion: "crewon.plugin-ui-props.v1",
          contributionId: "workbench",
          theme: { mode: "light", tokens: {} },
          data: {
            locale: "zh",
            hostPresentation: { context: { projectId: "p1" } },
            projectConversationAssociationThreadId: "t1",
          },
        } as PluginUiProps,
        { invoke },
      );
    });
    expect(root.querySelectorAll(".real-workspace-node")).toHaveLength(2);
    expect(root.querySelectorAll(".workspace-title-split")).toHaveLength(2);
    expect(root.querySelectorAll(".command-sidebar-thread-row")).toHaveLength(
      1,
    );
    expect(
      root
        .querySelector('[data-workspace-id="project-p2"] [aria-expanded]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(root.textContent).not.toContain("当前项目会话");
    expect(root.textContent).not.toContain("进入对话");
    expect(root.textContent).not.toContain("需求 v");
    expect(api.conversations).toHaveBeenCalledTimes(1);
    await act(async () =>
      root
        .querySelector<HTMLButtonElement>(
          '[data-workspace-id="project-p1"] .conversation-item',
        )!
        .click(),
    );
    expect(api.open).toHaveBeenCalledWith(
      { projectId: "p1", threadId: "t1" },
      expect.anything(),
    );
    await act(async () => instance.dispose());
    root.remove();
  });
});
