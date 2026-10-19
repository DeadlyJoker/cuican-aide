// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { RunEventView } from "@crewon/contracts";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import type { PluginUiDefinition } from "@crewon/plugin-sdk/ui";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import { useAppThreadState } from "../app/useAppThreadState";
import { useControlThreadRuntime } from "../control-runtime/useControlThreadRuntime";
import {
  settlementClient,
  settlementCompleted,
  settlementThreadId,
  settlementTime,
} from "../control-runtime/controlRunSettlement.test-support";
import { InstalledPluginModule } from "../../components/plugins/InstalledPluginModule";
import { createControlPluginUiHost } from "./controlPluginUiHost";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import { flush, uiLease } from "./pluginUiLoader.test-support";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type FoundationFixture = {
  metadata: {
    methodCalls(method: string): Array<{ input: { projectId?: string } }>;
  };
  seed(origin: "creative"): { project: { projectId: string } };
  proposal(projectId: string, text: string): unknown;
  services: {
    invoke(
      action: string,
      input: PluginJsonValue,
      options: { signal: AbortSignal },
    ): Promise<PluginJsonValue>;
  };
  methodCalls(method: string): unknown[];
};
const { foundationService } = await vi.importActual<{
  foundationService(): FoundationFixture;
}>(
  new URL(
    "../../../../../examples/plugins/short-drama/test/foundation-ui.test-support.mjs",
    import.meta.url,
  ).pathname,
);
const { sourceUiDefinition } = await vi.importActual<{
  sourceUiDefinition(): Promise<PluginUiDefinition>;
}>(
  new URL(
    "../../../../../examples/plugins/short-drama/test/source-ui.test-support.mjs",
    import.meta.url,
  ).pathname,
);

function feed() {
  const events: RunEventView[] = [];
  const streams = new Set<{ send(event: RunEventView): void; close(): void }>();
  let finished = false;
  return {
    open(cursor: number, signal?: AbortSignal | null) {
      let close!: () => void;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            const stream = {
              send(event: RunEventView) {
                const bytes = new TextEncoder().encode(
                  `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                );
                for (let offset = 0; offset < bytes.length; offset += 17)
                  controller.enqueue(bytes.slice(offset, offset + 17));
              },
              close() {
                if (closed) return;
                closed = true;
                streams.delete(stream);
                signal?.removeEventListener("abort", close);
                controller.close();
              },
            };
            close = stream.close;
            events
              .filter((event) => event.sequence > cursor)
              .forEach(stream.send);
            if (finished || signal?.aborted) close();
            else {
              streams.add(stream);
              signal?.addEventListener("abort", close, { once: true });
            }
          },
          cancel() {
            close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    send(event: RunEventView) {
      events.push(event);
      for (const stream of streams) stream.send(event);
    },
    close() {
      finished = true;
      for (const stream of [...streams]) stream.close();
    },
  };
}

async function settle() {
  for (let count = 0; count < 8; count++) await flush();
}

it("real SSE tool save updates the original plugin instance through scoped props and authenticated reads, preserving its dirty focused editor", async () => {
  const services = foundationService();
  const projectId = services.seed("creative").project.projectId;
  const definition = await sourceUiDefinition();
  const original = uiLease();
  const lease: PluginUiLease = {
    ...original,
    descriptor: {
      ...original.descriptor,
      pluginId: "crewon.short-drama",
      version: "50.2.4",
      requires: [
        {
          service: "crewon.project-foundation",
          apiVersion: "1",
          optional: true,
        },
        {
          service: "crewon.creative-projects",
          apiVersion: "1",
          optional: true,
        },
      ],
    },
  };
  const module: ControlPluginUiModule = {
    key: "short-drama",
    mountKey: "short-drama",
    title: "短剧",
    contributionId: "workbench",
    plugin: controlUiItem(lease),
  };
  const binding: PublicProjectConversationBinding = {
    bindingId: "foundation-binding",
    projectId,
    threadId: settlementThreadId,
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
    createdAt: settlementTime,
    updatedAt: settlementTime,
  };
  const durable = settlementClient(),
    runFeed = feed(),
    idleFeed = feed();
  let mounts = 0,
    disposed = 0,
    bindingReads = 0;
  const reads: string[] = [];
  const wire = controlUiClient(async (url, init) => {
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer captured-user-token",
    );
    if (url.pathname === "/api/v1/threads")
      return controlUiResponse({
        data: [(await durable.client.getThread(settlementThreadId)).thread],
        nextCursor: null,
      });
    if (url.pathname.endsWith("/project-conversation")) {
      bindingReads++;
      return controlUiResponse({ binding });
    }
    if (url.pathname.endsWith("/events"))
      return (
        url.pathname.startsWith("/api/v1/runs/") ? runFeed : idleFeed
      ).open(
        Number(new Headers(init.headers).get("last-event-id") ?? 0),
        init.signal,
      );
    if (url.pathname.endsWith("/goal"))
      return controlUiResponse({
        threadId: settlementThreadId,
        goal: null,
        eventSequence: 0,
      });
    if (url.pathname.endsWith("/actions")) {
      const request = JSON.parse(String(init.body)) as {
        action: string;
        input: PluginJsonValue;
      };
      reads.push(request.action);
      return controlUiResponse({
        output: await services.services.invoke(request.action, request.input, {
          signal: init.signal!,
        }),
      });
    }
    if (url.pathname.startsWith("/api/v1/plugins/ui/mounts/")) {
      if (init.method === "DELETE") return controlUiResponse({ closed: true });
      return controlUiResponse(lease);
    }
    if (url.pathname.endsWith("/ui/mounts") && init.method === "POST")
      return controlUiResponse(lease);
    throw new Error(`unexpected_foundation_wire:${url.pathname}`);
  });
  Object.assign(wire.client, {
    getThread: durable.client.getThread,
    getActiveAgentVersionCatalog: durable.client.getActiveAgentVersionCatalog,
    getExecutionIntentCapability: durable.client.getExecutionIntentCapability,
    startTurn: durable.client.startTurn,
    getThreadTranscriptWindow: durable.client.getThreadTranscriptWindow,
    getThreadActiveRun: durable.client.getThreadActiveRun,
    getRun: durable.client.getRun,
    getRunInThread: durable.client.getRunInThread,
    getRunPlan: durable.client.getRunPlan,
  });
  const importer = vi.fn(async () => ({
    default: {
      ...definition,
      mount: (async (root, props, ports) => {
        mounts++;
        const instance = await definition.mount(root, props, ports);
        return {
          update: instance.update.bind(instance),
          dispose() {
            disposed++;
            return instance.dispose();
          },
        };
      }) satisfies PluginUiDefinition["mount"],
    },
  }));
  const diagnostics = vi.fn();
  const host = createControlPluginUiHost({
    client: wire.client,
    assertCurrent() {},
    importer,
    onDiagnostic: diagnostics,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let state!: ReturnType<typeof useAppThreadState>;
  let authority!: ReturnType<typeof useControlThreadRuntime>;
  const page = {
    pageId: "foundation-page",
    context: { projectId, stage: "overview" },
    visible: true,
  } as const;
  function View() {
    state = useAppThreadState();
    authority = useControlThreadRuntime({
      ...state,
      client: wire.client,
      manageThreads: true,
      setThreadGoal() {},
      setNotice() {},
    });
    return (
      <InstalledPluginModule
        host={host}
        module={module}
        active
        uiPage={page}
        theme={{ mode: "light", tokens: { "--text": "#202020" } }}
        locale="zh"
        projectWorkspaceChangeClient={wire.client}
        onDiagnostic={diagnostics}
      />
    );
  }
  const panel = () =>
    container.querySelector<HTMLElement>('section[aria-label="创作方案"]')!;
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === label,
    )!;
  const requested = (
    runId: string,
    sequence: number,
    callId: string,
  ): RunEventView => ({
    eventId: `${runId}:${sequence}`,
    runId,
    sequence,
    occurredAt: settlementTime,
    type: "tool.requested",
    data: {
      segmentId: `${runId}:segment`,
      callId,
      kind: "function",
      name: "crewon_short_drama__foundation_proposal_save",
      inputTruncated: false,
      inputPreview: JSON.stringify({
        projectId,
        kind: "creative-plan",
        expectedFoundationRevision: 1,
        expectedProposalRevision: sequence === 1 ? 0 : 1,
      }),
    },
  });
  const completed = (
    runId: string,
    sequence: number,
    callId: string,
  ): RunEventView => ({
    eventId: `${runId}:${sequence}`,
    runId,
    sequence,
    occurredAt: settlementTime,
    type: "tool.completed",
    data: {
      segmentId: `${runId}:segment`,
      callId,
      kind: "function",
      name: "crewon_short_drama__foundation_proposal_save",
      isError: false,
      outputTruncated: false,
      artifactAvailable: false,
      outputPreview:
        "Tool says committed; this body must not become the workbench proposal.",
    },
  });
  try {
    await act(async () => {
      root.render(<View />);
      await settle();
    });
    await vi.waitFor(() =>
      expect(panel()?.textContent).toContain("与项目 Agent 讨论方案"),
    );
    expect(
      services.metadata
        .methodCalls("getProject")
        .some((call) => call.input.projectId === projectId),
    ).toBe(true);
    expect(
      services.metadata
        .methodCalls("getBrief")
        .some((call) => call.input.projectId === projectId),
    ).toBe(true);
    await vi.waitFor(() => expect(authority.connected).toBe(true));
    let runId!: string;
    await act(async () => {
      state.setSelectedThreadId(settlementThreadId);
      state.setThreads([
        await authority.runtime!.readThread(settlementThreadId),
      ]);
      runId = (
        await authority.runtime!.startTurn(settlementThreadId, "保存90秒方案")
      ).turn.id;
    });
    await act(async () => {
      runFeed.send(requested(runId, 1, "save-1"));
      await settle();
    });
    services.proposal(projectId, "90秒方案：连续录像，倒计时至80秒。");
    await act(async () => {
      runFeed.send(completed(runId, 2, "save-1"));
      await settle();
    });
    await vi.waitFor(() => expect(bindingReads).toBe(1));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(panel().textContent).toContain(
        "90秒方案：连续录像，倒计时至80秒。",
      );
    });
    expect(button("确认方案").disabled).toBe(false);
    expect(panel().textContent).not.toContain("Tool says committed");
    expect(panel().outerHTML).toMatchSnapshot(
      "saved candidate appears before Run terminal without refreshing the page",
    );
    await act(async () => {
      button("编辑方案").click();
      await settle();
    });
    const editor = panel().querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, "我的未提交修订：开场保留三秒停顿。");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    editor.focus();
    editor.setSelectionRange(4, 9);
    services.proposal(projectId, "Agent已保存第二版：80秒时发现录像画面异常。");
    await act(async () => {
      runFeed.send(requested(runId, 3, "save-2"));
      runFeed.send(completed(runId, 4, "save-2"));
      await settle();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(panel().textContent).toContain("Agent已保存第二版");
    });
    expect(panel().querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("我的未提交修订：开场保留三秒停顿。");
    expect(editor.disabled).toBe(false);
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 9]);
    expect(button("确认方案").disabled).toBe(true);
    await act(async () => {
      button("确认方案").click();
      await settle();
    });
    expect(services.methodCalls("confirmProposal")).toHaveLength(0);
    const beforeTerminal = services.methodCalls("listProposals").length;
    durable.complete(runId, "方案已保存，等待你确认。", 5);
    await act(async () => {
      runFeed.send(settlementCompleted(runId, 5));
      runFeed.close();
      await settle();
    });
    await vi.waitFor(() =>
      expect(state.activeTurnByThread[settlementThreadId]).toBeUndefined(),
    );
    expect(services.methodCalls("listProposals")).toHaveLength(
      beforeTerminal + 1,
    );
    expect(panel().querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("我的未提交修订：开场保留三秒停顿。");
    expect(editor.disabled).toBe(false);
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 9]);
    expect(button("确认方案").disabled).toBe(true);
    expect(mounts).toBe(1);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(0);
    expect(bindingReads).toBe(3);
    expect(reads.every((action) => /\.(get|list|read)/u.test(action))).toBe(
      true,
    );
    expect(services.methodCalls("confirmProposal")).toHaveLength(0);
    expect(services.methodCalls("saveProposal")).toHaveLength(0);
    expect(diagnostics).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      root.unmount();
      runFeed.close();
      idleFeed.close();
      await settle();
    });
    container.remove();
  }
});
