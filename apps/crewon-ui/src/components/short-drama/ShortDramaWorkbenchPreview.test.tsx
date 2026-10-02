// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ShortDramaWorkbenchPreview } from "./ShortDramaWorkbenchPreview";

it("shows an embeddable project list with the explicit demonstration boundary", () => {
  const markup = renderToStaticMarkup(
    <ShortDramaWorkbenchPreview referenceImage="/sample.png" />,
  );
  expect(markup).toContain('aria-label="AI 短剧工作台"');
  expect(markup).toContain('class="project-grid"');
  expect(markup).toContain("新建项目");
  expect(markup).toContain("生成服务设置");
  expect(markup).toContain("不实际扣费");
  expect(markup).not.toContain("<aside");
  expect(markup).not.toContain("<main");
  expect(markup).not.toMatch(
    /drama-sidebar|workspace-switch|class="brand"|class="account"|CREATIVE WORKSPACE|VISUAL DEVELOPMENT/,
  );
  expect(markup).toMatchSnapshot();
});

it("keeps project, concept, history and settings interactions inside the module without requests", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, "fetch");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const found = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent?.trim() === label);
    expect(found, label).toBeDefined();
    return found!;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
  };
  try {
    await act(async () =>
      root.render(<ShortDramaWorkbenchPreview referenceImage="/sample.png" />),
    );
    await click(container.querySelector<HTMLButtonElement>(".project-card")!);
    expect(container.querySelector(".page-heading h1")?.textContent).toBe(
      "窗边的来信",
    );
    expect(container.querySelector("#creative-brief")).not.toBeNull();
    await click(button("生成新版本"));
    expect(container.querySelector(".breadcrumbs")?.textContent).toContain(
      "概念图 v3",
    );
    await click(button("开始生成"));
    expect(container.querySelector(".status-stack")?.textContent).toContain(
      "排队中",
    );
    await click(button("查询原任务"));
    await click(button("设为选用"));
    expect(button("已设为选用").disabled).toBe(true);
    await click(button("查看生成记录"));
    expect(container.querySelector(".modal")?.textContent).toContain(
      "概念图修订 v3",
    );
    await click(
      container.querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')!,
    );
    await click(button("生成服务设置"));
    expect(container.querySelector(".modal")?.textContent).toContain(
      "本预览不会调用",
    );
    await click(
      container.querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')!,
    );
    await click(button("返回项目"));
    await click(button("v2"));
    expect(container.querySelector(".modal")?.textContent).toContain("需求 v2");
    expect(container.querySelector(".modal")?.textContent).toContain("需求 v1");
    await click(
      container.querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')!,
    );
    await click(button("AI 短剧"));
    expect(container.querySelector(".project-grid")).not.toBeNull();
    expect(container.querySelector("aside")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
