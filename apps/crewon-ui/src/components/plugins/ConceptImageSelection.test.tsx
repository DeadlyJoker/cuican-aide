// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginCreativeProjectClient,
  createPluginProjectGenerationClient,
  createPluginProjectGenerationContextClient,
  createPluginProjectGenerationReadClient,
  createPluginProjectGenerationQueryClient,
  createPluginProjectGenerationSelectionClient,
  type PluginCreativeProjectClient,
  type PluginProjectGenerationClient,
  type PluginProjectGenerationContextClient,
  type PluginProjectGenerationReadClient,
  type PluginProjectGenerationQueryClient,
  type PluginProjectGenerationSelectionClient,
  type ProjectGenerationSelectionHostContext,
} from "@crewon/plugin-sdk/ui";
import {
  selectionService,
  selectImageAction,
  selectionReadAction,
} from "../../../../../examples/plugins/short-drama/test/selection-submit.test-support.mjs";
import { flush } from "../../lib/plugins/pluginUiLoader.test-support";

type Controller = {
  setReady(ready: boolean): void;
  setSelectionContext(
    context: ProjectGenerationSelectionHostContext | null,
  ): void;
  dispose(): void;
};
const { CreativeProjectController } = await vi.importActual<{
  CreativeProjectController: new (ports: {
    projects: PluginCreativeProjectClient;
    submissions: PluginProjectGenerationClient;
    contexts: PluginProjectGenerationContextClient;
    generations: PluginProjectGenerationReadClient;
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
  for (let i = 0; i < 6; ++i) await flush();
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
async function fixture(service: ReturnType<typeof selectionService>) {
  const controller = new CreativeProjectController({
    projects: createPluginCreativeProjectClient(service.services),
    submissions: createPluginProjectGenerationClient(service.services),
    contexts: createPluginProjectGenerationContextClient(service.services),
    generations: createPluginProjectGenerationReadClient(service.services),
    queries: createPluginProjectGenerationQueryClient(service.services),
    selections: createPluginProjectGenerationSelectionClient(service.services),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, controller });
  service.watch(() =>
    controller.setSelectionContext(service.selectionContext()),
  );
  await act(async () => {
    root.render(<ShortDramaPersistentWorkbench controller={controller} />);
    controller.setSelectionContext(service.selectionContext());
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
  await click(container.querySelector<HTMLButtonElement>(".project-card")!);
  await click(
    container.querySelector<HTMLButtonElement>(
      ".concept-panel > button.version-card",
    )!,
  );
  return {
    controller,
    container,
    button,
    click,
    panel: () => container.querySelector('[aria-label="概念图选用"]')!,
    image: (index = 2) =>
      container.querySelector<HTMLButtonElement>(
        `[data-operation-id] [data-result-index="${index}"] button`,
      )!,
  };
}
const savedConcept = (service: ReturnType<typeof selectionService>) => {
  const project = service.create("选用项目", "已保存需求");
  return service.createConcept(
    project.project.projectId,
    "雨夜街角",
    1,
    "已保存画面",
  );
};

describe("independent exact concept image selection", () => {
  it("renders exact image choices and current historical confirmation with a new snapshot", async () => {
    const service = selectionService(),
      saved = savedConcept(service);
    service.seedImages(saved);
    const f = await fixture(service);
    expect(service.callsFor(selectionReadAction)).toHaveLength(1);
    expect(f.image().disabled).toBe(false);
    await f.click(f.image());
    expect(service.callsFor(selectImageAction)[0].input).toMatchObject({
      resultIndex: 2,
      expectedOperationRevision: 9,
      expectedSelectionRevision: 0,
    });
    service.externalBrief(saved.project.projectId, "最新需求");
    await f.click(f.button("刷新当前选用"));
    expect(f.panel().textContent).toContain("需重新确认");
    expect(f.panel().outerHTML).toMatchSnapshot(
      "current image from historical requirement",
    );
    expect(
      f.container.querySelector('[data-operation-id] [data-result-index="2"]')!
        .outerHTML,
    ).toMatchSnapshot("explicit raw image index choice");
  });
  it("shows a retained UNKNOWN request and blocks editing or replacement with a new snapshot", async () => {
    const service = selectionService(),
      saved = savedConcept(service);
    service.seedImages(saved);
    service.setSelectionMode("lost");
    const f = await fixture(service);
    await f.click(f.image());
    expect(f.button("返回概念列表").disabled).toBe(true);
    expect(f.button("归档项目").disabled).toBe(true);
    expect(f.image(0).disabled).toBe(true);
    expect(f.panel().outerHTML).toMatchSnapshot(
      "unknown selection retains original request",
    );
    const original = service.callsFor(selectImageAction)[0].input;
    service.setSelectionMode("success");
    await f.click(f.button("重试原选用"));
    expect(service.callsFor(selectImageAction)[1].input).toEqual(original);
  });
  it("renders unavailable current state after a confirmed write without projecting its old receipt as current", async () => {
    const service = selectionService(),
      saved = savedConcept(service);
    service.seedImages(saved);
    const f = await fixture(service);
    service.failSelectionRead(true);
    await f.click(f.image());
    expect(f.panel().querySelector("[data-selected-result-index]")).toBeNull();
    expect(f.panel().textContent).toContain("原选用请求已确认");
    expect(f.image().disabled).toBe(true);
    expect(f.panel().outerHTML).toMatchSnapshot(
      "accepted receipt with unavailable current read",
    );
  });
});
