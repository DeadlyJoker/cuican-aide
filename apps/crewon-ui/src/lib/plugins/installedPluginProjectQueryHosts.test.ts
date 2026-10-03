// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { PROJECT_GENERATION_QUERY_UI_ACTIONS } from "@crewon/contracts/plugins";
import { createControlPluginUiHost } from "./controlPluginUiHost";
import { createDesktopPluginUiHost } from "./desktopPluginUiHost";
import { createInstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import {
  queryJournalLease,
  queryJournalInput,
  queryJournalReceipt,
} from "./installedPluginProjectQuery.test-support";
import {
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import {
  deferred,
  flush,
  uiHarness,
  uiProps,
} from "./pluginUiLoader.test-support";
import { desktopPluginUiAssetUrl } from "../desktop/desktopPluginUiProtocol";
import type { PluginUiMountHandle } from "./trustedPluginUiLoader";
const handles: PluginUiMountHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function fixture(native: boolean, enabled = true) {
  if (native) vi.stubGlobal("location", { protocol: "file:", origin: "null" });
  const lease = queryJournalLease(),
    h = uiHarness();
  const gate = deferred<Response>();
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error("captured_query_account_changed");
  };
  const query = createInstalledPluginProjectQueryJournal({
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  const generation = createInstalledPluginGenerationJournal({
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  const observer = vi.fn();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).endsWith("/actions"))
      return gate.promise;
    return controlUiResponse(
      init?.method === "DELETE" ? { closed: true } : lease,
    );
  });
  const client = new ControlApiClient({
    baseUrl: native ? "http://127.0.0.1:32100" : location.origin,
    accessToken: "named-query-session",
    csrfToken: "named-query-csrf",
    fetch,
  });
  const binding = {
    bindingRef: "c".repeat(64),
    entryUrl: desktopPluginUiAssetUrl("c".repeat(64), "ui/index.js"),
    controlOrigin: client.requestOrigin,
  };
  const options = {
    client,
    assertCurrent,
    onDiagnostic: vi.fn(),
    onTaskReceipt: observer,
    generationJournal: generation,
    ...(enabled ? { projectQueryJournal: query } : {}),
    importer: vi.fn(async () => ({ default: h.definition })),
  };
  const host = native
    ? createDesktopPluginUiHost({
        ...options,
        assets: {
          version: 1,
          adopt: vi.fn(async () => binding),
          release: vi.fn(async () => {}),
          invalidate: vi.fn(async () => {}),
        },
      })
    : createControlPluginUiHost(options);
  return {
    lease,
    h,
    query,
    generation,
    observer,
    gate,
    fetch,
    host,
    revoke: () => {
      current = false;
    },
  };
}
for (const native of [false, true])
  describe(
    native ? "native query transport" : "Control query transport",
    () => {
      it("keeps the exact query in its separate account journal after module cancellation and observes a late accepted receipt", async () => {
        const f = fixture(native);
        const lease = await f.host.acquireMount(
          controlUiItem(f.lease),
          "workbench",
          new AbortController().signal,
        );
        const handle = await f.host.loader.mount({
          root: f.h.root,
          lease,
          props: uiProps(),
        });
        handles.push(handle);
        const input = queryJournalInput();
        const call = f.h.instances[0].services.invoke(
          PROJECT_GENERATION_QUERY_UI_ACTIONS[0],
          input,
          {},
        );
        void call.catch(() => undefined);
        await flush();
        const action = f.fetch.mock.calls.find(([url]) =>
          String(url).endsWith("/actions"),
        )!;
        expect(JSON.parse(String(action[1]?.body))).toEqual({
          action: PROJECT_GENERATION_QUERY_UI_ACTIONS[0],
          input,
        });
        expect(new Headers(action[1]?.headers).get("authorization")).toBe(
          "Bearer named-query-session",
        );
        expect(new Headers(action[1]?.headers).get("x-csrf-token")).toBe(
          "named-query-csrf",
        );
        await handle.stop();
        await expect(call).rejects.toThrow();
        expect(f.query.snapshot()[0].phase).toBe("uncertain");
        expect(f.query.snapshot()[0].retryable).toBe(false);
        f.gate.resolve(
          controlUiResponse({ output: queryJournalReceipt(input) }),
        );
        await flush();
        await flush();
        expect(f.query.snapshot()[0].phase).toBe("accepted");
        expect(f.query.snapshot()[0].receipt?.runId).toBe("target-query-run");
        expect(f.generation.snapshot()).toEqual([]);
        expect(f.observer).not.toHaveBeenCalled();
        expect(
          f.fetch.mock.calls.filter(([url]) =>
            String(url).endsWith("/actions"),
          ),
        ).toHaveLength(1);
      });
      it("requires explicit query journal assembly and never falls through to ordinary task receipt transport", async () => {
        const f = fixture(native, false);
        const lease = await f.host.acquireMount(
          controlUiItem(f.lease),
          "workbench",
          new AbortController().signal,
        );
        const handle = await f.host.loader.mount({
          root: f.h.root,
          lease,
          props: uiProps(),
        });
        handles.push(handle);
        await expect(
          f.h.instances[0].services.invoke(
            PROJECT_GENERATION_QUERY_UI_ACTIONS[0],
            queryJournalInput(),
            {},
          ),
        ).rejects.toThrow("plugin_ui_project_query_journal_unavailable");
        expect(
          f.fetch.mock.calls.some(([url]) => String(url).endsWith("/actions")),
        ).toBe(false);
        expect(f.observer).not.toHaveBeenCalled();
      });
    },
  );
