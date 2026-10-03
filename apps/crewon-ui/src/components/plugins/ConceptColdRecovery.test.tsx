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
  parseProjectGenerationHostContext,
  parseProjectGenerationQueryHostContext,
  parseProjectGenerationSelectionHostContext,
  type PluginCreativeProjectClient,
  type PluginProjectGenerationClient,
  type PluginProjectGenerationContextClient,
  type PluginProjectGenerationReadClient,
  type PluginProjectGenerationQueryClient,
  type PluginProjectGenerationSelectionClient,
  type ProjectGenerationHostContext,
  type ProjectGenerationQueryHostContext,
  type ProjectGenerationSelectionHostContext,
} from "@crewon/plugin-sdk/ui";
import type {
  ProjectGenerationUiInput,
  ProjectGenerationQueryUiInput,
  ProjectGenerationSelectionUiInput,
} from "@crewon/plugin-sdk/contracts";
import { coldRecoveryService } from "../../../../../examples/plugins/short-drama/test/cold-recovery.test-support.mjs";
import { flush } from "../../lib/plugins/pluginUiLoader.test-support";
type Contexts = {
  generation: ProjectGenerationHostContext | null;
  query: ProjectGenerationQueryHostContext | null;
  selection: ProjectGenerationSelectionHostContext | null;
};
type Controller = {
  setReady(ready: boolean): void;
  setRecoveryContexts(contexts: Contexts): void;
  getSnapshot(): { recoveryConflict: boolean };
  concepts: {
    getSnapshot(): {
      selection: null | {
        asset: { assetId: string };
        revision: { assetRevision: number };
      };
    };
    submissions: {
      getSnapshot(): { request: ProjectGenerationUiInput | null };
    };
    queries: {
      getSnapshot(): { request: ProjectGenerationQueryUiInput | null };
    };
    images: {
      getSnapshot(): { request: ProjectGenerationSelectionUiInput | null };
    };
  };
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
const mounted: {
  root: Root;
  controller: Controller;
  service: ReturnType<typeof coldRecoveryService>;
}[] = [];
async function settle() {
  for (let i = 0; i < 8; i++) await flush();
}
afterEach(async () => {
  for (const { root, controller, service } of mounted.splice(0)) {
    service.watch(() => {});
    controller.dispose();
    await act(async () => {
      root.unmount();
      await settle();
    });
  }
  document.body.replaceChildren();
});
async function fixture(service: ReturnType<typeof coldRecoveryService>) {
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
  const contexts = () => {
    const values = service.contexts();
    return {
      generation: parseProjectGenerationHostContext(values.generation),
      query: parseProjectGenerationQueryHostContext(values.query),
      selection: parseProjectGenerationSelectionHostContext(values.selection),
    };
  };
  mounted.push({ root, controller, service });
  service.watch(() => controller.setRecoveryContexts(contexts()));
  await act(async () => {
    root.render(<ShortDramaPersistentWorkbench controller={controller} />);
    controller.setRecoveryContexts(contexts());
    controller.setReady(true);
    await settle();
  });
  const button = (label: string) => {
    const element = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent?.trim() === label);
    expect(element, label).toBeDefined();
    return element!;
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
      await settle();
    });
  };
  return { controller, container, button, click };
}
const generate = "crewon.project-generations.v1.generateConcept",
  query = "crewon.project-generation-queries.v1.queryConceptGeneration",
  select = "crewon.project-generation-selections.v1.selectConceptImage";
const op = "00000000-0000-0000-0000-000000000001";
function sources() {
  const service = coldRecoveryService(),
    project = service.create("冷恢复项目", "原需求");
  const a = service.createConcept(
    project.project.projectId,
    "历史画面 A",
    1,
    "A原文",
  );
  const b = service.createConcept(
    project.project.projectId,
    "未确认画面 B",
    1,
    "B原文",
  );
  const generationA = service.seedImages(a),
    generationB = service.seedImages(b);
  const source = (saved: typeof a) => ({
    projectId: saved.project.projectId,
    assetId: saved.asset.assetId,
    assetRevision: saved.assetRevision.assetRevision,
  });
  const reference = (saved: typeof a) => ({
    ...source(saved),
    expectedProjectRevision: b.project.revision,
    expectedAssetMetadataRevision: saved.asset.revision,
  });
  const gen = (saved: typeof a): ProjectGenerationUiInput => ({
    reference: reference(saved),
    threadId: "original-generation-thread",
    expectedThreadRevision: 7,
    idempotencyKey: `generation-${saved.asset.assetId}`,
  });
  const qry = (saved: typeof a): ProjectGenerationQueryUiInput => ({
    reference: source(saved),
    operationId: op,
    threadId: "original-generation-thread",
    expectedThreadRevision: 7,
    idempotencyKey: `query-${saved.asset.assetId}`,
  });
  const img = (saved: typeof a): ProjectGenerationSelectionUiInput => ({
    reference: reference(saved),
    operationId: op,
    expectedOperationRevision: 9,
    resultIndex: 2,
    expectedSelectionRevision: 0,
    idempotencyKey: `selection-${saved.asset.assetId}`,
  });
  const receipt = (runId: string) => ({
    disposition: "committed" as const,
    threadId: "original-generation-thread",
    threadRevision: 8,
    runId,
    messageId: `${runId}-message`,
    configurationRevision: 3,
  });
  return { service, a, b, gen, qry, img, receipt, generationA, generationB };
}
const assertNoWrites = (service: ReturnType<typeof coldRecoveryService>) => {
  for (const action of [generate, query, select])
    expect(service.callsFor(action)).toHaveLength(0);
};

describe("fresh controller captures all recovery lanes before readonly source adoption", () => {
  it("fences an already pending terminal read when a full context update introduces another source's UNKNOWN", async () => {
    const s = sources(),
      old = s.img(s.a),
      body = s.qry(s.b),
      receipt = s.service.commitSelection(old);
    s.service.setSelectionIntent({
      request: old,
      phase: "accepted",
      retryable: false,
      receipt,
    });
    const a = s.service.gateSource(s.a.asset.assetId),
      f = await fixture(s.service);
    await act(async () => {
      s.service.setQueryIntent({
        request: body,
        phase: "uncertain",
        retryable: true,
        receipt: null,
      });
      await settle();
    });
    expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
      s.b.asset.assetId,
    );
    await act(async () => {
      a.resolve();
      await settle();
    });
    expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
      s.b.asset.assetId,
    );
    expect(f.controller.concepts.queries.getSnapshot().request).toEqual(body);
    expect(f.controller.concepts.images.getSnapshot().request).toEqual(old);
    assertNoWrites(s.service);
    await f.click("重试原查询");
    expect(s.service.callsFor(query)[0].input).toEqual(body);
  });
  it("keeps UNKNOWN on an unavailable historical source, then restores its exact input after archive and metadata changes without a write", async () => {
    const s = sources(),
      body = s.qry(s.b);
    s.service.setQueryIntent({
      request: body,
      phase: "uncertain",
      retryable: true,
      receipt: null,
    });
    const gate = s.service.gateSource(s.b.asset.assetId),
      f = await fixture(s.service);
    await act(async () => {
      gate.reject();
      await settle();
    });
    expect(f.controller.concepts.getSnapshot().selection).toBeNull();
    expect(f.controller.concepts.queries.getSnapshot().request).toEqual(body);
    expect(f.button("重试原查询").disabled).toBe(true);
    expect(f.button("新建项目").disabled).toBe(true);
    assertNoWrites(s.service);
    s.service.externalConceptRevision(
      s.b.project.projectId,
      s.b.asset.assetId,
      1,
      "新画面",
    );
    s.service.externalBrief(s.b.project.projectId, "新需求");
    s.service.records.get(s.b.project.projectId)!.project.state = "archived";
    await f.click("重新读取原查询输入");
    expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
      s.b.asset.assetId,
    );
    expect(
      f.controller.concepts.getSnapshot().selection?.revision.assetRevision,
    ).toBe(1);
    expect(f.controller.concepts.queries.getSnapshot().request).toEqual(body);
    assertNoWrites(s.service);
    expect(f.button("重试原查询").disabled).toBe(false);
  });
  for (const completion of ["history-first", "unknown-first"] as const) {
    it(`retains generation UNKNOWN B while query accepted A finishes ${completion}`, async () => {
      const s = sources(),
        body = s.gen(s.b),
        old = s.qry(s.a);
      s.service.setGenerationIntent({
        request: body,
        phase: "uncertain",
        retryable: true,
        receipt: null,
      });
      s.service.setQueryIntent({
        request: old,
        phase: "accepted",
        retryable: false,
        receipt: s.receipt("old-query-run"),
      });
      const a = s.service.gateSource(s.a.asset.assetId),
        b = s.service.gateSource(s.b.asset.assetId),
        f = await fixture(s.service);
      expect(s.service.gatedReads.map((item) => item.assetId)).toEqual(
        expect.arrayContaining([s.a.asset.assetId, s.b.asset.assetId]),
      );
      await act(async () => {
        (completion === "history-first" ? a : b).resolve();
        await settle();
      });
      if (completion === "history-first")
        expect(f.controller.concepts.getSnapshot().selection).toBeNull();
      else
        expect(
          f.controller.concepts.getSnapshot().selection?.asset.assetId,
        ).toBe(s.b.asset.assetId);
      await act(async () => {
        (completion === "history-first" ? b : a).resolve();
        await settle();
      });
      expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
        s.b.asset.assetId,
      );
      expect(f.controller.concepts.submissions.getSnapshot().request).toEqual(
        body,
      );
      expect(f.controller.concepts.queries.getSnapshot().request).toEqual(old);
      expect(f.container.textContent).toContain("未确认画面 B");
      assertNoWrites(s.service);
      await f.click("重试原生成请求");
      expect(s.service.callsFor(generate)[0].input).toEqual(body);
      expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
        s.b.asset.assetId,
      );
    });
    it(`retains query UNKNOWN B while selection accepted A finishes ${completion}`, async () => {
      const s = sources(),
        body = s.qry(s.b),
        old = s.img(s.a),
        receipt = s.service.commitSelection(old);
      s.service.setQueryIntent({
        request: body,
        phase: "uncertain",
        retryable: true,
        receipt: null,
      });
      s.service.setSelectionIntent({
        request: old,
        phase: "accepted",
        retryable: false,
        receipt,
      });
      const a = s.service.gateSource(s.a.asset.assetId),
        b = s.service.gateSource(s.b.asset.assetId),
        f = await fixture(s.service);
      await act(async () => {
        (completion === "history-first" ? a : b).resolve();
        await settle();
      });
      await act(async () => {
        (completion === "history-first" ? b : a).resolve();
        await settle();
      });
      expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
        s.b.asset.assetId,
      );
      expect(f.controller.concepts.queries.getSnapshot().request).toEqual(body);
      expect(f.controller.concepts.images.getSnapshot().request).toEqual(old);
      assertNoWrites(s.service);
      expect(f.button("重试原查询").disabled).toBe(false);
      await f.click("重试原查询");
      expect(s.service.callsFor(query)[0].input).toEqual(body);
      expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
        s.b.asset.assetId,
      );
      expect(
        f.container.querySelector(
          '[aria-label="概念图选用"] [data-selected-result-index]',
        ),
      ).toBeNull();
    });
  }
  it("allows a same-source generation receipt and UNKNOWN query to coexist without changing either key", async () => {
    const s = sources(),
      gen = s.gen(s.b),
      qry = s.qry(s.b);
    s.service.setGenerationIntent({
      request: gen,
      phase: "accepted",
      retryable: false,
      receipt: s.receipt(s.generationB.task.runId),
    });
    s.service.setQueryIntent({
      request: qry,
      phase: "uncertain",
      retryable: true,
      receipt: null,
    });
    const f = await fixture(s.service);
    expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
      s.b.asset.assetId,
    );
    expect(f.controller.concepts.submissions.getSnapshot().request).toEqual(
      gen,
    );
    expect(f.controller.concepts.queries.getSnapshot().request).toEqual(qry);
    expect(f.controller.getSnapshot().recoveryConflict).toBe(false);
    assertNoWrites(s.service);
    await f.click("重试原查询");
    expect(s.service.callsFor(query)[0].input).toEqual(qry);
  });
  it("retains every different-source UNKNOWN, blocks retries and resumes readonly recovery after one is definitively accepted", async () => {
    const s = sources(),
      gen = s.gen(s.a),
      qry = s.qry(s.b);
    s.service.setGenerationIntent({
      request: gen,
      phase: "uncertain",
      retryable: true,
      receipt: null,
    });
    s.service.setQueryIntent({
      request: qry,
      phase: "uncertain",
      retryable: true,
      receipt: null,
    });
    const f = await fixture(s.service);
    expect(f.controller.getSnapshot().recoveryConflict).toBe(true);
    expect(f.controller.concepts.getSnapshot().selection).toBeNull();
    expect(f.controller.concepts.submissions.getSnapshot().request).toEqual(
      gen,
    );
    expect(f.controller.concepts.queries.getSnapshot().request).toEqual(qry);
    expect(f.button("重试原生成请求").disabled).toBe(true);
    expect(f.button("重试原查询").disabled).toBe(true);
    expect(f.container.textContent).toContain("多个来自不同输入的未确认请求");
    assertNoWrites(s.service);
    await act(async () => {
      s.service.setGenerationIntent({
        request: gen,
        phase: "accepted",
        retryable: false,
        receipt: s.receipt(s.generationA.task.runId),
      });
      await settle();
    });
    expect(f.controller.getSnapshot().recoveryConflict).toBe(false);
    expect(f.controller.concepts.getSnapshot().selection?.asset.assetId).toBe(
      s.b.asset.assetId,
    );
    expect(f.controller.concepts.queries.getSnapshot().request).toEqual(qry);
    assertNoWrites(s.service);
    await f.click("重试原查询");
    expect(s.service.callsFor(query)[0].input).toEqual(qry);
  });
});
