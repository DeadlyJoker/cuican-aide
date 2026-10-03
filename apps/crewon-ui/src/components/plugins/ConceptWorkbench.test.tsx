// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginCreativeProjectClient,
  createPluginProjectGenerationReadClient,
  createPluginProjectGenerationClient,
  createPluginProjectGenerationContextClient,
  createPluginProjectGenerationQueryClient,
  createPluginProjectGenerationSelectionClient,
  type PluginCreativeProjectClient,
  type PluginProjectGenerationReadClient,
  type PluginProjectGenerationClient,
  type PluginProjectGenerationContextClient,
  type PluginProjectGenerationQueryClient,
  type PluginProjectGenerationSelectionClient,
} from "@crewon/plugin-sdk/ui";
import {
  deferred,
  metadataService,
} from "../../../../../examples/plugins/short-drama/test/persistent-ui.test-support.mjs";
import { flush } from "../../lib/plugins/pluginUiLoader.test-support";

// The installed module is an independent TS project, checked against the public SDK separately.
type Controller = { setReady(ready: boolean): void; dispose(): void };
const { CreativeProjectController } = await vi.importActual<{
  CreativeProjectController: new (ports: {
    projects: PluginCreativeProjectClient;
    generations: PluginProjectGenerationReadClient;
    submissions: PluginProjectGenerationClient;
    contexts: PluginProjectGenerationContextClient;
    queries: PluginProjectGenerationQueryClient;
    selections: PluginProjectGenerationSelectionClient;
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
const mounted: { root: Root; controller: Controller }[] = [];
async function settle() {
  for (let count = 0; count < 6; count++) await flush();
}
afterEach(async () => {
  for (const { root, controller } of mounted.splice(0)) {
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
    selections: createPluginProjectGenerationSelectionClient(service.services),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, controller });
  const render = async () => {
    await act(async () => {
      root.render(<ShortDramaPersistentWorkbench controller={controller} />);
      await settle();
    });
  };
  await render();
  await act(async () => {
    controller.setReady(true);
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
  const input = async (selector: string, value: string) => {
    const element = container.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(selector)!;
    expect(element).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        element.tagName === "INPUT"
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
  };
  await click(container.querySelector<HTMLButtonElement>(".project-card")!);
  return { container, button, click, input, render, controller };
}

describe("independent persisted concept inputs", () => {
  it("retains a conflicting draft and source, then explicitly saves with fresh project and asset CAS", async () => {
    const service = metadataService();
    const { project } = service.create("并行概念", "来源一");
    const created = service.createConcept(
      project.projectId,
      "街角",
      1,
      "原描述",
    );
    const f = await fixture(service);
    await f.click(f.button("街角输入 v1"));
    await f.click(f.button("编辑为新修订"));
    await f.input("#concept-prompt", " 我的输入\n保留 ");
    service.externalConceptRevision(
      project.projectId,
      created.asset.assetId,
      1,
      "另一处保存",
    );
    service.externalBrief(project.projectId, "来源二");
    await f.click(f.button("保存为新输入修订"));
    expect(f.container.textContent).toContain("草稿已保留");
    await f.click(f.button("重新读取概念版本"));
    expect(service.methodCalls("appendConceptRevision")).toHaveLength(1);
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#concept-prompt")!.value,
    ).toBe(" 我的输入\n保留 ");
    expect(f.button("按最新版本保存概念修订").disabled).toBe(true);
    await f.click(
      f.container.querySelector<HTMLInputElement>(
        '[aria-label="确认沿用需求 v1"]',
      )!,
    );
    await f.click(f.button("按最新版本保存概念修订"));
    const calls = service.methodCalls("appendConceptRevision");
    expect(calls).toHaveLength(2);
    expect(calls[0].input).toMatchObject({
      request: { expectedProjectRevision: 3, expectedAssetMetadataRevision: 1 },
    });
    expect(calls[1].input).toMatchObject({
      request: {
        expectedProjectRevision: 5,
        expectedAssetMetadataRevision: 2,
        briefRevision: 1,
        prompt: " 我的输入\n保留 ",
      },
    });
    expect(calls[1].input).not.toEqual(calls[0].input);
    expect(
      service.records.get(project.projectId)!.assets.get(created.asset.assetId)!
        .revisions,
    ).toHaveLength(3);
  });
  it("binds the saved requirement, preserves drafts on rerender/cancel and renders the original scoped panel", async () => {
    const service = metadataService();
    const { project, brief } = service.create(
      "概念故事",
      " 已保存需求\n 原文 ",
    );
    const f = await fixture(service);
    await f.input("#creative-brief", "未保存需求草稿");
    await f.click(f.button("新建概念输入"));
    await f.input('[aria-label="概念名称"]', "  雨夜街角  ");
    const prompt = " 雨夜\n 霓虹映照街角 ";
    await f.input("#concept-prompt", prompt);
    await f.render();
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#concept-prompt")!.value,
    ).toBe(prompt);
    await f.click(f.button("返回概念列表"));
    await f.click(f.button("新建概念输入"));
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#concept-prompt")!.value,
    ).toBe(prompt);
    expect(
      f.container.querySelector(".concept-panel")!.outerHTML,
    ).toMatchSnapshot("concept draft");
    await f.click(f.button("保存概念输入"));
    expect(service.methodCalls("createConcept")[0].input).toMatchObject({
      projectId: project.projectId,
      request: {
        name: "雨夜街角",
        briefRevision: 1,
        prompt,
        expectedProjectRevision: 2,
      },
    });
    const record = service.records.get(project.projectId)!;
    const [asset] = record.assets.values();
    expect(asset.revisions[0].briefContentDigest).toBe(brief.contentDigest);
    expect(record.project.revision).toBe(3);
    expect(record.briefs).toHaveLength(1);
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#creative-brief")!.value,
    ).toBe("未保存需求草稿");
    expect(
      f.container.querySelector(".concept-panel")!.outerHTML,
    ).toMatchSnapshot("saved concept input");
    expect(f.container.querySelector("img")).toBeNull();
  });

  it("keeps immutable historical inputs separate from asset metadata CAS and requires an old-brief confirmation", async () => {
    const service = metadataService({ pageSize: 1 });
    const { project } = service.create("历史故事", "旧需求");
    const first = service.createConcept(project.projectId, "街角", 1, "输入一");
    const entry = service.records
      .get(project.projectId)!
      .assets.get(first.asset.assetId)!;
    entry.asset = { ...entry.asset, revision: 7 };
    service.externalConceptRevision(
      project.projectId,
      first.asset.assetId,
      1,
      "输入二",
    );
    service.externalBrief(project.projectId, "新的已保存需求");
    const f = await fixture(service);
    await f.click(f.button("街角输入 v2"));
    await f.click(f.button("查看输入历史"));
    await f.click(f.button("加载更多输入修订"));
    expect(service.methodCalls("listConceptRevisions")[1].input).toMatchObject({
      assetId: first.asset.assetId,
      query: { afterAssetRevision: 1 },
    });
    await f.click(f.button("返回概念列表"));
    expect(
      f.container.querySelector(".concept-panel")!.textContent,
    ).not.toContain("查看修订");
    expect(
      f.container.querySelector(".concept-panel")!.textContent,
    ).not.toContain("加载更多输入修订");
    await f.click(f.button("街角输入 v2"));
    await f.click(f.button("查看输入历史"));
    await f.click(f.button("查看修订 v1"));
    expect(service.methodCalls("getConceptRevision").at(-1)!.input).toEqual({
      projectId: project.projectId,
      assetId: first.asset.assetId,
      assetRevision: 1,
    });
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#concept-prompt")!
        .readOnly,
    ).toBe(true);
    await f.click(f.button("编辑为新修订"));
    await f.input("#concept-prompt", "复用旧需求的新输入");
    expect(f.button("保存为新输入修订").disabled).toBe(true);
    await f.click(
      f.container.querySelector<HTMLInputElement>(
        '[aria-label="确认沿用需求 v1"]',
      )!,
    );
    await f.click(f.button("保存为新输入修订"));
    expect(service.methodCalls("appendConceptRevision")[0].input).toMatchObject(
      {
        assetId: first.asset.assetId,
        request: {
          briefRevision: 1,
          expectedAssetMetadataRevision: 8,
          expectedProjectRevision: 5,
          prompt: "复用旧需求的新输入",
        },
      },
    );
    expect(entry.revisions.map((revision) => revision.prompt)).toEqual([
      "输入一",
      "输入二",
      "复用旧需求的新输入",
    ]);
    expect(entry.revisions[2].assetRevision).toBe(3);
    expect(entry.asset.revision).toBe(9);
  });

  it("retries the frozen receipt and refreshes an archived live project without regressing its current state", async () => {
    const service = metadataService();
    const { project } = service.create("回执故事", "来源");
    const f = await fixture(service);
    await f.click(f.button("新建概念输入"));
    await f.input("#concept-prompt", "同一输入");
    service.loseNextWrite();
    await f.click(f.button("保存概念输入"));
    expect(f.container.textContent).toContain("概念保存结果尚未确认");
    expect(f.button("归档项目").disabled).toBe(true);
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#concept-prompt")!.value,
    ).toBe("同一输入");
    const record = service.records.get(project.projectId)!;
    const client = createPluginCreativeProjectClient(service.services);
    await client.setProjectState({
      projectId: project.projectId,
      request: {
        state: "archived",
        expectedProjectRevision: record.project.revision,
      },
      idempotencyKey: "archive-after-concept",
    });
    await f.click(f.button("重试原概念请求"));
    const calls = service.methodCalls("createConcept");
    expect(calls).toHaveLength(2);
    expect(calls[1].input).toEqual(calls[0].input);
    expect(record.assets.size).toBe(1);
    expect([...record.assets.values()][0].revisions).toHaveLength(1);
    expect(f.container.textContent).toContain("项目已归档");
    expect(f.button("编辑为新修订").disabled).toBe(true);
    expect(f.button("恢复项目").disabled).toBe(false);
    expect(record.project.revision).toBe(4);
  });

  it("discards a late selection, keeps cancelled drafts and enforces the UTF-16 prompt limit before writes", async () => {
    const service = metadataService();
    const { project } = service.create("取消读取", "来源");
    const seeded = service.createConcept(
      project.projectId,
      "迟到输入",
      1,
      "迟到原文",
    );
    const f = await fixture(service);
    const gate = deferred();
    service.gateConceptRead("getConceptRevision", gate);
    await f.click(f.button("迟到输入输入 v1"));
    await f.click(
      f.container.querySelector<HTMLButtonElement>(".breadcrumbs button")!,
    );
    await act(async () => {
      gate.resolve({ assetRevision: seeded.assetRevision });
      await settle();
    });
    expect(f.container.querySelector("#concept-prompt")).toBeNull();
    await f.click(
      f.container.querySelector<HTMLButtonElement>(".project-card")!,
    );
    await f.click(f.button("新建概念输入"));
    await f.input("#concept-prompt", "😀".repeat(1001));
    expect(f.button("保存概念输入").disabled).toBe(true);
    expect(service.methodCalls("createConcept")).toHaveLength(0);
    await f.click(f.button("返回概念列表"));
    await f.click(f.button("新建概念输入"));
    expect(
      f.container.querySelector<HTMLTextAreaElement>("#concept-prompt")!.value,
    ).toBe("😀".repeat(1001));
    await f.input("#concept-prompt", "😀".repeat(1000));
    expect(f.button("保存概念输入").disabled).toBe(false);
    await f.click(f.button("保存概念输入"));
    expect(service.methodCalls("createConcept")).toHaveLength(1);
  });
});
