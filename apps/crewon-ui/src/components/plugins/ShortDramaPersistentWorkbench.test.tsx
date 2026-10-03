// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginCreativeProjectClient,
  createPluginProjectGenerationReadClient,
  createPluginProjectGenerationClient,
  createPluginProjectGenerationContextClient,
  createPluginProjectGenerationQueryClient,
  type PluginCreativeProjectClient,
  type PluginProjectGenerationReadClient,
  type PluginProjectGenerationClient,
  type PluginProjectGenerationContextClient,
  type PluginProjectGenerationQueryClient,
} from "@crewon/plugin-sdk/ui";
import { metadataService } from "../../../../../examples/plugins/short-drama/test/persistent-ui.test-support.mjs";
import { flush } from "../../lib/plugins/pluginUiLoader.test-support";

// Test-only loading keeps the independent package outside the host's composite TS project.
// The package's own strict typecheck verifies the implementation and its public SDK imports.
type Controller = { setReady(ready: boolean): void; dispose(): void };
const { CreativeProjectController } = await vi.importActual<{
  CreativeProjectController: new (ports: {
    projects: PluginCreativeProjectClient;
    generations: PluginProjectGenerationReadClient;
    submissions: PluginProjectGenerationClient;
    contexts: PluginProjectGenerationContextClient;
    queries: PluginProjectGenerationQueryClient;
  }) => Controller;
}>(
  new URL(
    "../../../../../examples/plugins/short-drama/src/workbench/creative-project-controller.ts",
    import.meta.url,
  ).pathname,
);
const { ShortDramaPersistentWorkbench } = await vi.importActual<{
  ShortDramaPersistentWorkbench: ComponentType<{ controller: Controller }>;
}>(
  new URL(
    "../../../../../examples/plugins/short-drama/src/workbench/ShortDramaPersistentWorkbench.tsx",
    import.meta.url,
  ).pathname,
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: { root: Root; controller: Controller }[] = [];
async function settle() {
  for (let count = 0; count < 5; count++) await flush();
}
afterEach(async () => {
  for (const { root, controller } of roots.splice(0)) {
    controller.dispose();
    await act(async () => {
      root.unmount();
      await settle();
    });
  }
  document.body.replaceChildren();
});
async function fixture(service: ReturnType<typeof metadataService>) {
  const controller = new CreativeProjectController({
    projects: createPluginCreativeProjectClient(service.services),
    generations: createPluginProjectGenerationReadClient(service.services),
    submissions: createPluginProjectGenerationClient(service.services),
    contexts: createPluginProjectGenerationContextClient(service.services),
    queries: createPluginProjectGenerationQueryClient(service.services),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, controller });
  await act(async () => {
    root.render(<ShortDramaPersistentWorkbench controller={controller} />);
    await settle();
  });
  const button = (label: string) => {
    const found = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent?.trim() === label);
    expect(found, label).toBeDefined();
    return found!;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
      await settle();
    });
  };
  const input = async (element: HTMLTextAreaElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
  };
  return {
    root,
    container,
    controller,
    button,
    click,
    input,
    async ready() {
      await act(async () => {
        controller.setReady(true);
        await settle();
      });
    },
    async open() {
      await click(container.querySelector<HTMLButtonElement>(".project-card")!);
    },
  };
}

describe("independent short-drama persistent presentation", () => {
  it("retains the scoped original layout while waiting, with no account, shell or generation claims", () => {
    const service = metadataService();
    const controller = new CreativeProjectController({
      projects: createPluginCreativeProjectClient(service.services),
      generations: createPluginProjectGenerationReadClient(service.services),
      submissions: createPluginProjectGenerationClient(service.services),
      contexts: createPluginProjectGenerationContextClient(service.services),
      queries: createPluginProjectGenerationQueryClient(service.services),
    });
    const markup = renderToStaticMarkup(
      <ShortDramaPersistentWorkbench controller={controller} />,
    );
    expect(markup).toMatchSnapshot();
    expect(markup).toContain("正在等待模块就绪");
    expect(markup).not.toMatch(
      /<aside|<main|sidebar-account|command-window|窗边的来信|演示数据/,
    );
    expect(service.calls).toHaveLength(0);
    controller.dispose();
  });

  it("waits for actual ready and displays host refusal without an in-memory fallback", async () => {
    const service = metadataService();
    service.refuse(true);
    const f = await fixture(service);
    expect(service.calls).toHaveLength(0);
    await f.ready();
    expect(f.container.textContent).toContain("项目服务暂不可用");
    expect(f.container.querySelectorAll(".project-card")).toHaveLength(0);
    expect(service.calls).toHaveLength(1);
  });

  it("preserves the confirmed text and retries an unconfirmed commit with the original key and CAS", async () => {
    const service = metadataService();
    service.create("保存回执", "最初需求");
    const f = await fixture(service);
    await f.ready();
    await f.open();
    const text = " 需求原文\n 下一行 ";
    await f.input(
      f.container.querySelector<HTMLTextAreaElement>("#creative-brief")!,
      text,
    );
    service.loseNextWrite();
    await f.click(f.button("保存为新版本"));
    expect(f.container.textContent).toContain("保存结果尚未确认");
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#creative-brief")!.value,
    ).toBe(text);
    await f.click(f.button("重试原请求"));
    const calls = service.methodCalls("appendBrief");
    expect(calls).toHaveLength(2);
    expect(calls[1].input).toEqual(calls[0].input);
    const [record] = service.records.values();
    expect(record.project.revision).toBe(3);
    expect(record.briefs).toHaveLength(2);
    expect(record.briefs[1].text).toBe(text);
    expect(f.container.textContent).toContain("已保存新的需求版本");
  });

  it("keeps a conflicting draft, rereads the live revision and only resubmits after explicit confirmation", async () => {
    const service = metadataService();
    const { project } = service.create("并行修改", "最初需求");
    const f = await fixture(service);
    await f.ready();
    await f.open();
    const text = "我的确认内容\n ";
    await f.input(
      f.container.querySelector<HTMLTextAreaElement>("#creative-brief")!,
      text,
    );
    service.externalBrief(project.projectId, "其他地方的修改");
    await f.click(f.button("保存为新版本"));
    expect(f.container.textContent).toContain("项目已有新版本");
    await f.click(f.button("重新读取版本"));
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#creative-brief")!.value,
    ).toBe(text);
    expect(service.methodCalls("appendBrief")).toHaveLength(1);
    await f.click(f.button("按最新版本保存"));
    const calls = service.methodCalls("appendBrief");
    expect(calls[0].input).toMatchObject({
      request: { expectedProjectRevision: 2 },
    });
    expect(calls[1].input).toMatchObject({
      request: { expectedProjectRevision: 3, text },
    });
    expect(calls[1].input).not.toEqual(calls[0].input);
    expect(service.records.get(project.projectId)!.briefs).toHaveLength(3);
  });

  it("reads the latest saved brief after a fresh module controller and never invents concept results", async () => {
    const service = metadataService();
    const { project } = service.create("重新进入", "第一版");
    service.externalBrief(project.projectId, " 保存后的第二版\n ");
    const f = await fixture(service);
    await f.ready();
    await f.open();
    expect(service.methodCalls("getBrief")[0].input).toEqual({
      projectId: project.projectId,
      briefRevision: 2,
    });
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#creative-brief")!.value,
    ).toBe(" 保存后的第二版\n ");
    expect(f.container.querySelector("img")).toBeNull();
    expect(f.container.textContent).not.toMatch(/已完成|已选用|演示任务/);
  });
});
