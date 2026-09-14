// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  CommandSidebar,
  type CommandLinkedThread,
} from "./CommandWorkspaceChrome";
import type { CommandHomeSlots } from "./commandWorkspaceState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const resource = { detail: "", label: "", title: "", value: "" };
const slots: CommandHomeSlots = {
  agent: resource,
  knowledge: resource,
  mcps: [resource, resource],
  model: "",
  skills: [resource, resource],
  workflow: resource,
};
const workspaces = [
  { workspaceId: "workspace-a", displayName: "Project A" },
  { workspaceId: "workspace-b", displayName: "Project B" },
  { workspaceId: "workspace-empty", displayName: "Empty project" },
];
const threads: CommandLinkedThread[] = [
  {
    id: "thread-a",
    workspaceId: "workspace-a",
    title: "Task A",
    preview: "",
    cwd: null,
    updatedLabel: "Today",
  },
  {
    id: "thread-b",
    workspaceId: "workspace-b",
    title: "Task B",
    preview: "",
    cwd: null,
    updatedLabel: "Today",
  },
  {
    id: "thread-old",
    title: "Old unbound task",
    preview: "",
    cwd: null,
    updatedLabel: "Today",
  },
];

it("keeps every conversation under its persisted owner when adding and activating workspaces", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  const onActivate = vi.fn();
  const onOpen = vi.fn();
  const render = async (workspaceId: string) =>
    act(async () =>
      root.render(
        <CommandSidebar
          activeView="command"
          cwd=""
          controlWorkspace={{
            name: workspaces.find((space) => space.workspaceId === workspaceId)!
              .displayName,
            workspaceId,
            workspaces,
            busy: false,
            onSelect,
            onActivate,
          }}
          isSearchOpen={false}
          linkedThreads={threads}
          locale="zh"
          query=""
          selectedLinkedThreadId={null}
          slots={slots}
          workspaceAuthority="control"
          onCloseSearch={() => {}}
          onNewThread={() => {}}
          onOpenLinkedThread={onOpen}
          onQueryChange={() => {}}
          onSwitchView={() => {}}
          onToggleCollapse={() => {}}
          onToggleSearch={() => {}}
        />,
      ),
    );
  const button = (label: string) => {
    const found = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const assertOwnership = () => {
    expect(
      container.querySelector(
        '[data-workspace-id="workspace-a"] [data-linked-thread-id="thread-a"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-workspace-id="workspace-b"] [data-linked-thread-id="thread-b"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '.standalone-thread-list [data-linked-thread-id="thread-old"]',
      ),
    ).not.toBeNull();
    for (const thread of threads)
      expect(
        container.querySelectorAll(`[data-linked-thread-id="${thread.id}"]`),
      ).toHaveLength(1);
    expect(
      container.querySelector('[data-workspace-id="workspace-empty"]')
        ?.textContent,
    ).toContain("Empty project");
  };
  try {
    await render("workspace-a");
    assertOwnership();
    await act(async () => button("新增空间").click());
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="更换工作空间"]')).toBeNull();
    const activate = container.querySelector<HTMLButtonElement>(
      '[data-workspace-id="workspace-b"] .workspace-title-toggle',
    )!;
    await act(async () => activate.click());
    expect(onActivate).toHaveBeenCalledExactlyOnceWith("workspace-b");
    await render("workspace-b");
    assertOwnership();
    expect(
      container
        .querySelector(".space-node.current")
        ?.getAttribute("data-workspace-id"),
    ).toBe("workspace-b");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-linked-thread-id="thread-a"]')!
        .click(),
    );
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("thread-a");
    expect(container.querySelector(".space-tree")?.outerHTML).toMatchSnapshot();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
