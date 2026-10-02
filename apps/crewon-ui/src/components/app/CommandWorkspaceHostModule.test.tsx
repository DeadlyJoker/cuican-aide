// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandWorkspaceHostModulePane,
  useCommandWorkspaceHostModule,
  type CommandWorkspaceHostModule,
} from "./CommandWorkspaceHostModule";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function click(selector: string) {
  const element = container?.querySelector(selector);
  expect(element).not.toBeNull();
  await act(async () =>
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

describe("CommandWorkspaceHostModule content composition", () => {
  it("keeps an absent contribution out of the existing host DOM", () => {
    for (const active of [true, false])
      expect(
        renderToStaticMarkup(
          <CommandWorkspaceHostModulePane module={undefined} active={active} />,
        ),
      ).toBe("");
  });

  it("preserves the existing ReactNode section and markup for both visibility states", () => {
    const module: CommandWorkspaceHostModule = {
      id: "crewon.short-drama",
      label: "AI 短剧",
      content: <article data-original-content="true">原有模块内容</article>,
    };
    expect(
      renderToStaticMarkup(
        <CommandWorkspaceHostModulePane module={module} active={false} />,
      ),
    ).toBe(
      '<section aria-label="AI 短剧" class="shell-view" data-host-module-id="crewon.short-drama" hidden=""><article data-original-content="true">原有模块内容</article></section>',
    );
    expect(
      renderToStaticMarkup(
        <CommandWorkspaceHostModulePane module={module} active={true} />,
      ),
    ).toBe(
      '<section aria-label="AI 短剧" class="shell-view active" data-host-module-id="crewon.short-drama"><article data-original-content="true">原有模块内容</article></section>',
    );
  });

  it("passes only the host-owned active flag to the content callback", () => {
    const content = vi.fn(({ active }: Readonly<{ active: boolean }>) => (
      <p data-active={String(active)}>动态模块</p>
    ));
    const module: CommandWorkspaceHostModule = {
      id: "example.module",
      label: "动态模块",
      content,
    };
    const hidden = renderToStaticMarkup(
      <CommandWorkspaceHostModulePane module={module} active={false} />,
    );
    const visible = renderToStaticMarkup(
      <CommandWorkspaceHostModulePane module={module} active={true} />,
    );
    expect(content.mock.calls).toEqual([
      [{ active: false }],
      [{ active: true }],
    ]);
    expect(hidden).toContain('hidden=""');
    expect(hidden).toContain('data-active="false"');
    expect(visible).not.toContain('hidden=""');
    expect(visible).toContain('data-active="true"');
  });

  it("preserves parent and module state while real navigation events change child activity", async () => {
    const activity = vi.fn();
    const rendered = vi.fn();
    function Module({ active }: Readonly<{ active: boolean }>) {
      const [revision, setRevision] = useState(1);
      useEffect(() => activity(active), [active]);
      return (
        <article data-child-active={String(active)}>
          <span data-revision>{revision}</span>
          <button
            data-action="append"
            onClick={() => setRevision((value) => value + 1)}
          >
            新增版本
          </button>
        </article>
      );
    }
    function Host() {
      const [title, setTitle] = useState("初始项目");
      const module: CommandWorkspaceHostModule = {
        id: "crewon.short-drama",
        label: "AI 短剧",
        content: ({ active }) => {
          rendered(active);
          return <Module active={active} />;
        },
      };
      const selected = useCommandWorkspaceHostModule(module);
      return (
        <>
          <p data-project-title>{title}</p>
          <button data-action="rename" onClick={() => setTitle("已保存项目")}>
            改名
          </button>
          <button data-action="open" onClick={selected.open}>
            AI 短剧
          </button>
          <button data-action="home" onClick={selected.close}>
            首页
          </button>
          <CommandWorkspaceHostModulePane
            module={module}
            active={selected.active}
          />
        </>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Host />));
    const pane = container.querySelector<HTMLElement>("[data-host-module-id]")!;
    const child = container.querySelector("article");
    expect(pane.hidden).toBe(true);
    expect(activity.mock.calls).toEqual([[false]]);
    await click('[data-action="open"]');
    expect(pane.hidden).toBe(false);
    expect(child?.getAttribute("data-child-active")).toBe("true");
    await click('[data-action="append"]');
    await click('[data-action="rename"]');
    await click('[data-action="home"]');
    expect(pane.hidden).toBe(true);
    expect(child?.getAttribute("data-child-active")).toBe("false");
    expect(container.querySelector("[data-project-title]")?.textContent).toBe(
      "已保存项目",
    );
    await click('[data-action="open"]');
    expect(container.querySelector("article")).toBe(child);
    expect(container.querySelector("[data-revision]")?.textContent).toBe("2");
    expect(activity.mock.calls).toEqual([[false], [true], [false], [true]]);
    expect(rendered.mock.calls.at(-1)).toEqual([true]);
  });
});
