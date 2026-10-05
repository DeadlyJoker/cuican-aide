// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InstalledPluginModule } from "./InstalledPluginModule";
import { createControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import { createInstalledPluginProjectHistoricalQueryJournal } from "../../lib/plugins/installedPluginProjectHistoricalQueryJournal";
import {
  historicalQueryInput,
  historicalQueryLease,
} from "../../lib/plugins/installedPluginProjectHistoricalQuery.test-support";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "../../lib/plugins/controlPluginUi.test-support";
import { taskContextThread } from "../../lib/plugins/installedPluginTaskContext.test-support";
import { uiHarness } from "../../lib/plugins/pluginUiLoader.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("publishes only the independent session-only history context and retains the original unknown intent across module hide/reopen without staging or dispatch", async () => {
  const lease = historicalQueryLease(),
    h = uiHarness();
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error("history-module-account-withdrawn");
  };
  const journal = createInstalledPluginProjectHistoricalQueryJournal({
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  const wire = controlUiClient((url, init) => {
    if (init.method === "DELETE") return controlUiResponse({ closed: true });
    if (url.pathname === "/api/v1/threads/thread-1")
      return controlUiResponse({
        thread: taskContextThread("thread-1", 17),
        eventSequence: 17,
      });
    if (url.pathname.includes("/actions") || url.pathname.includes("/recovery"))
      throw new Error("module-view-must-not-dispatch");
    return controlUiResponse(lease);
  });
  const host = createControlPluginUiHost({
    client: wire.client,
    assertCurrent,
    historicalQueryJournal: journal,
    onDiagnostic: vi.fn(),
    importer: async () => ({ default: h.definition }),
  });
  const module = {
    key: JSON.stringify([lease.descriptor.pluginId, lease.contributionId]),
    mountKey: "installed-history-view",
    title: "历史查询",
    contributionId: lease.contributionId,
    plugin: controlUiItem(lease),
  };
  const root = createRoot(h.root);
  const render = (active: boolean) =>
    act(async () =>
      root.render(
        <InstalledPluginModule
          host={host}
          module={module}
          active={active}
          theme={{ mode: "light", tokens: {} }}
          locale="zh"
          onDiagnostic={vi.fn()}
          historicalQueryPorts={{
            client: wire.client,
            journal,
            assertSessionCurrent: assertCurrent,
            runtime: { adoptExtensionTask: vi.fn(async () => undefined) },
            onOpenTask: vi.fn(),
          }}
          selectedThreadId="thread-1"
        />,
      ),
    );
  // The module content is actual PluginModuleMount JSON from the portable fixture definition.
  const context = () =>
    JSON.parse(
      [...h.root.querySelectorAll("div")].find((node) =>
        node.textContent?.startsWith('{"locale"'),
      )?.textContent ?? "null",
    ) as Record<string, unknown> | null;
  try {
    await render(true);
    await act(async () => {
      await vi.waitFor(() =>
        expect(context()?.projectHistoricalQueryHostContext).toMatchObject({
          recovery: "session-only",
          phase: "ready",
          threadReady: true,
          intent: null,
        }),
      );
    });
    expect(context()).not.toHaveProperty("projectGenerationQueryContext");
    const input = historicalQueryInput();
    await act(async () => {
      await journal
        .invoke({
          lease,
          input,
          signal: new AbortController().signal,
          request: async () => {
            throw new Error("named-history-response-unknown");
          },
        })
        .catch(() => undefined);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(context()?.projectHistoricalQueryHostContext).toMatchObject({
          phase: "uncertain",
          intent: { request: input, retryable: true },
        }),
      );
    });
    await render(false);
    expect(h.root.textContent).toBe("");
    await render(true);
    await act(async () => {
      await vi.waitFor(() =>
        expect(context()?.projectHistoricalQueryHostContext).toMatchObject({
          recovery: "session-only",
          phase: "uncertain",
          intent: { request: input },
        }),
      );
    });
    expect(
      wire.fetch.mock.calls.some(
        ([url]) =>
          String(url).includes("/actions") || String(url).includes("/recovery"),
      ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    current = false;
    await journal.close();
    h.root.remove();
  }
});
