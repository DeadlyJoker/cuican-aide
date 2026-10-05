import {
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import { createInstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { PROJECT_HISTORICAL_QUERY_UI_ACTIONS } from "@crewon/contracts/project-historical-queries";
import { createControlPluginUiHost } from "./controlPluginUiHost";
import { createDesktopPluginUiHost } from "./desktopPluginUiHost";
import { createInstalledPluginProjectHistoricalQueryJournal } from "./installedPluginProjectHistoricalQueryJournal";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import {
  historicalQueryLease,
  historicalQueryInput,
  historicalQueryReceipt,
} from "./installedPluginProjectHistoricalQuery.test-support";
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
  const rawLease = historicalQueryLease();
  const lease = parsePluginUiLease({
      ...rawLease,
      descriptor: {
        ...rawLease.descriptor,
        requires: [
          ...rawLease.descriptor.requires,
          {
            service: "crewon.project-generation-queries",
            apiVersion: "1",
            optional: true,
          },
        ],
      },
    }),
    h = uiHarness();
  const gate = deferred<Response>();
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error("captured_query_account_changed");
  };
  const oldQuery = createInstalledPluginProjectQueryJournal({
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  const query = createInstalledPluginProjectHistoricalQueryJournal({
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
    projectQueryJournal: oldQuery,
    ...(enabled ? { historicalQueryJournal: query } : {}),
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
    oldQuery,
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
        const input = historicalQueryInput();
        const call = f.h.instances[0].services.invoke(
          PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
          input,
          {},
        );
        void call.catch(() => undefined);
        await flush();
        const action = f.fetch.mock.calls.find(([url]) =>
          String(url).endsWith("/actions"),
        )!;
        expect(JSON.parse(String(action[1]?.body))).toEqual({
          action: PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
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
          controlUiResponse({ output: historicalQueryReceipt(input) }),
        );
        await flush();
        await flush();
        expect(f.query.snapshot()[0].phase).toBe("accepted");
        expect(f.query.snapshot()[0].receipt?.runId).toBe("target-query-run");
        expect(f.generation.snapshot()).toEqual([]);
        expect(f.oldQuery.snapshot()).toEqual([]);
        expect(
          f.fetch.mock.calls.some(([url]) => String(url).includes("/recovery")),
        ).toBe(false);
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
            PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
            historicalQueryInput(),
            {},
          ),
        ).rejects.toThrow(
          "plugin_ui_project_historical_query_journal_unavailable",
        );
        expect(
          f.fetch.mock.calls.some(([url]) => String(url).endsWith("/actions")),
        ).toBe(false);
        expect(f.observer).not.toHaveBeenCalled();
      });
      it.each(["pending", "uncertain"] as const)(
        "an unresolved %s original query blocks history dispatch without relabeling or clearing the old authority",
        async (phase) => {
          const f = fixture(native);
          const input = historicalQueryInput();
          if (phase === "pending")
            f.oldQuery.register({ lease: f.lease, input });
          else
            await f.oldQuery
              .invoke({
                lease: f.lease,
                input,
                signal: new AbortController().signal,
                request: async () => {
                  throw new Error("original-query-response-unknown");
                },
              })
              .catch(() => undefined);
          const before = f.oldQuery.snapshot();
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
              PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
              input,
              {},
            ),
          ).rejects.toThrow("plugin_ui_query_lane_unresolved");
          expect(f.query.snapshot()).toEqual([]);
          expect(f.oldQuery.snapshot()).toEqual(before);
          expect(
            f.fetch.mock.calls.some(([url]) =>
              String(url).endsWith("/actions"),
            ),
          ).toBe(false);
        },
      );
      it("an unresolved history query blocks the original self lane before staging or dispatch", async () => {
        const f = fixture(native),
          input = historicalQueryInput();
        f.query.register({ lease: f.lease, input });
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
            input,
            {},
          ),
        ).rejects.toThrow("plugin_ui_query_lane_unresolved");
        expect(f.oldQuery.snapshot()).toEqual([]);
        expect(f.query.snapshot()[0].input).toEqual(input);
        expect(
          f.fetch.mock.calls.some(
            ([url]) =>
              String(url).endsWith("/actions") ||
              String(url).includes("/recovery"),
          ),
        ).toBe(false);
      });
    },
  );
