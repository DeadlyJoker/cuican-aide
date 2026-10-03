// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import {
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
  parsePluginUiLease,
} from "@crewon/contracts/plugins";
import { createControlPluginUiHost } from "./controlPluginUiHost";
import { createDesktopPluginUiHost } from "./desktopPluginUiHost";
import { createInstalledPluginProjectSelectionJournal } from "./installedPluginProjectSelectionJournal";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import {
  selectionJournalLease,
  selectionJournalInput,
  selectionJournalReceipt,
} from "./installedPluginProjectSelection.test-support";
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
  let lease = selectionJournalLease();
  const h = uiHarness();
  let actionResponse: Response | null = null;
  let currentResponse = { selectionRevision: 0, current: null } as unknown;
  let revoked = false;
  const gate = deferred<Response>();
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error("captured_selection_account_changed");
  };
  const selection = createInstalledPluginProjectSelectionJournal({
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  const generation = createInstalledPluginGenerationJournal({
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  const observer = vi.fn();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).endsWith("/actions")) {
      const action = JSON.parse(String(init.body)).action;
      if (action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[0])
        return controlUiResponse({ output: currentResponse });
      return actionResponse ?? gate.promise;
    }
    if (init?.method === "GET" && revoked)
      return controlUiResponse(
        { error: { code: "plugin_ui_mount_unavailable", message: "Revoked" } },
        409,
      );
    return controlUiResponse(
      init?.method === "DELETE" ? { closed: true } : lease,
    );
  });
  const client = new ControlApiClient({
    baseUrl: native ? "http://127.0.0.1:32100" : location.origin,
    accessToken: "named-selection-session",
    csrfToken: "named-selection-csrf",
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
    ...(enabled ? { selectionJournal: selection } : {}),
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
    get lease() {
      return lease;
    },
    h,
    selection,
    generation,
    observer,
    gate,
    fetch,
    host,
    setLease(value: typeof lease) {
      lease = value;
      revoked = false;
    },
    revokeMount: () => {
      revoked = true;
    },
    reply(value: Response) {
      actionResponse = value;
    },
    current(value: unknown) {
      currentResponse = value;
    },
    revoke: () => {
      current = false;
    },
  };
}
for (const native of [false, true])
  describe(
    native ? "native selection transport" : "Control selection transport",
    () => {
      it("keeps the exact selection in its separate account journal after module cancellation and observes a late accepted receipt", async () => {
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
        const input = selectionJournalInput();
        const call = f.h.instances[0].services.invoke(
          PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
          input,
          {},
        );
        void call.catch(() => undefined);
        await flush();
        const action = f.fetch.mock.calls.find(([url]) =>
          String(url).endsWith("/actions"),
        )!;
        expect(JSON.parse(String(action[1]?.body))).toEqual({
          action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
          input,
        });
        expect(new Headers(action[1]?.headers).get("authorization")).toBe(
          "Bearer named-selection-session",
        );
        expect(new Headers(action[1]?.headers).get("x-csrf-token")).toBe(
          "named-selection-csrf",
        );
        await handle.stop();
        await expect(call).rejects.toThrow();
        expect(f.selection.snapshot()[0].phase).toBe("uncertain");
        expect(f.selection.snapshot()[0].retryable).toBe(false);
        f.gate.resolve(
          controlUiResponse({ output: selectionJournalReceipt(input) }),
        );
        await flush();
        await flush();
        expect(f.selection.snapshot()[0].phase).toBe("accepted");
        expect(f.selection.snapshot()[0].receipt?.selection.resultIndex).toBe(
          input.resultIndex,
        );
        expect(f.generation.snapshot()).toEqual([]);
        expect(f.observer).not.toHaveBeenCalled();
        expect(
          f.fetch.mock.calls.filter(([url]) =>
            String(url).endsWith("/actions"),
          ),
        ).toHaveLength(1);
      });
      it("requires explicit selection journal assembly and never falls through to ordinary task receipt transport", async () => {
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
            PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
            selectionJournalInput(),
            {},
          ),
        ).rejects.toThrow("plugin_ui_project_selection_journal_unavailable");
        expect(
          f.fetch.mock.calls.some(([url]) => String(url).endsWith("/actions")),
        ).toBe(false);
        expect(f.observer).not.toHaveBeenCalled();
      });
      it("a separately authenticated GET reads the current pointer without writing a recovery or task receipt", async () => {
        const f = fixture(native, false);
        const receipt = selectionJournalReceipt();
        const current = {
          selectionRevision: 7,
          current: {
            ...receipt.selection,
            resultIndex: 3,
            requiresConfirmation: true,
          },
        };
        f.current(current);
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
        const result = await f.h.instances[0].services.invoke(
          PROJECT_GENERATION_SELECTION_UI_ACTIONS[0],
          { projectId: "project-1", assetId: "asset-1" },
          {},
        );
        expect(result).toEqual(current);
        expect(f.selection.snapshot()).toEqual([]);
        expect(f.generation.snapshot()).toEqual([]);
        expect(f.observer).not.toHaveBeenCalled();
        const action = f.fetch.mock.calls.find(([url]) =>
          String(url).endsWith("/actions"),
        )!;
        expect(JSON.parse(String(action[1]?.body))).toEqual({
          action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[0],
          input: { projectId: "project-1", assetId: "asset-1" },
        });
        expect(new Headers(action[1]?.headers).get("authorization")).toBe(
          "Bearer named-selection-session",
        );
      });
      it("UNKNOWN retries only through a freshly acquired and validated same-package regrant, retaining the exact key and original audit pin", async () => {
        const f = fixture(native),
          input = selectionJournalInput(),
          original = f.lease;
        const lease = await f.host.acquireMount(
          controlUiItem(original),
          "workbench",
          new AbortController().signal,
        );
        const handle = await f.host.loader.mount({
          root: f.h.root,
          lease,
          props: uiProps(),
        });
        handles.push(handle);
        f.reply(
          controlUiResponse(
            { error: { code: "reply_lost", message: "Reply lost" } },
            503,
          ),
        );
        await expect(
          f.h.instances[0].services.invoke(
            PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
            input,
            {},
          ),
        ).rejects.toThrow();
        expect(f.selection.snapshot()[0]).toMatchObject({
          phase: "uncertain",
          retryable: true,
        });
        f.revokeMount();
        const writes = () =>
          f.fetch.mock.calls.filter(([url]) =>
            String(url).endsWith("/actions"),
          );
        await expect(
          f.h.instances[0].services.invoke(
            PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
            input,
            {},
          ),
        ).rejects.toThrow();
        expect(writes()).toHaveLength(1);
        expect(f.selection.snapshot()[0].phase).toBe("uncertain");
        await handle.stop();
        f.setLease(
          parsePluginUiLease({
            ...selectionJournalLease("example.workbench", 2),
            selectionRevision: 8,
          }),
        );
        f.reply(
          controlUiResponse({
            output: {
              ...selectionJournalReceipt(input),
              disposition: "replayed",
            },
          }),
        );
        const next = await f.host.acquireMount(
          controlUiItem(f.lease),
          "workbench",
          new AbortController().signal,
        );
        const remounted = await f.host.loader.mount({
          root: f.h.root,
          lease: next,
          props: uiProps(),
        });
        handles.push(remounted);
        expect(writes()).toHaveLength(1);
        await f.h.instances[1].services.invoke(
          PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
          input,
          {},
        );
        expect(writes()).toHaveLength(2);
        expect(JSON.parse(String(writes()[1][1]?.body)).input).toEqual(input);
        expect(String(writes()[1][0])).toContain(next.mountRef);
        expect(
          f.fetch.mock.calls.some(
            ([url, init]) =>
              init?.method === "GET" && String(url).endsWith(next.mountRef),
          ),
        ).toBe(true);
        expect(f.selection.snapshot()[0]).toMatchObject({
          sourcePin: { selectionRevision: original.selectionRevision },
          phase: "accepted",
          input,
        });
        expect(f.observer).not.toHaveBeenCalled();
      });
      it("a changed account cannot publish an old physical selection reply", async () => {
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
        const call = f.h.instances[0].services.invoke(
          PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
          selectionJournalInput(),
          {},
        );
        void call.catch(() => {});
        await flush();
        f.revoke();
        f.gate.resolve(
          controlUiResponse({ output: selectionJournalReceipt() }),
        );
        await expect(call).rejects.toThrow();
        await flush();
        expect(f.selection.snapshot()).toEqual([]);
        expect(f.observer).not.toHaveBeenCalled();
      });
      it.each([
        "creative_project_revision_conflict",
        "creative_project_asset_revision_conflict",
        "concept_selection_operation_revision_conflict",
        "concept_selection_revision_conflict",
      ])(
        "an initial validated %s refuses before COMMIT and permits a new explicit click after current/source refresh",
        async (code) => {
          const f = fixture(native),
            input = selectionJournalInput();
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
          f.reply(
            controlUiResponse(
              {
                error: {
                  category: "conflict",
                  code,
                  message: "Revision changed",
                  requestId: "selection-first-conflict",
                },
              },
              409,
            ),
          );
          await expect(
            f.h.instances[0].services.invoke(
              PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
              input,
              {},
            ),
          ).rejects.toBeInstanceOf(ControlApiClientError);
          expect(f.selection.snapshot()[0]).toMatchObject({
            phase: "refused",
            retryable: false,
            receipt: null,
            reasonCode: code,
          });
          const writes = () =>
            f.fetch.mock.calls.filter(
              ([url, init]) =>
                String(url).endsWith("/actions") &&
                JSON.parse(String(init?.body)).action ===
                  PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
            );
          expect(writes()).toHaveLength(1);
          f.current({
            selectionRevision: 3,
            current: {
              ...selectionJournalReceipt().selection,
              requiresConfirmation: false,
            },
          });
          await f.h.instances[0].services.invoke(
            PROJECT_GENERATION_SELECTION_UI_ACTIONS[0],
            { projectId: "project-1", assetId: "asset-1" },
            {},
          );
          const next = {
            ...input,
            reference: {
              ...input.reference,
              expectedProjectRevision: 8,
              expectedAssetMetadataRevision: 5,
            },
            expectedOperationRevision: 4,
            expectedSelectionRevision: 3,
            idempotencyKey: "new-click-after-refresh",
          };
          f.reply(controlUiResponse({ output: selectionJournalReceipt(next) }));
          expect(writes()).toHaveLength(1);
          await f.h.instances[0].services.invoke(
            PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
            next,
            {},
          );
          expect(writes()).toHaveLength(2);
          expect(f.selection.snapshot()[0]).toMatchObject({
            phase: "accepted",
            input: next,
          });
          expect(f.selection.snapshot()[1].phase).toBe("refused");
        },
      );
      it.each([401, 403, 404, 409])(
        "an earlier lost acknowledgement stays UNKNOWN after a later validated %s response",
        async (status) => {
          const f = fixture(native),
            input = selectionJournalInput();
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
          f.reply(
            controlUiResponse(
              {
                error: {
                  category: "internal",
                  code: "reply_lost",
                  message: "Lost acknowledgement",
                  requestId: "first-unknown",
                },
              },
              503,
            ),
          );
          await expect(
            f.h.instances[0].services.invoke(
              PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
              input,
              {},
            ),
          ).rejects.toBeInstanceOf(ControlApiClientError);
          f.reply(
            controlUiResponse(
              {
                error: {
                  category:
                    status === 409
                      ? "conflict"
                      : status === 401
                        ? "authentication"
                        : status === 403
                          ? "authorization"
                          : "notFound",
                  code: "concept_selection_revision_conflict",
                  message: "Later denial",
                  requestId: "later-retry",
                },
              },
              status,
            ),
          );
          await expect(
            f.h.instances[0].services.invoke(
              PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
              input,
              {},
            ),
          ).rejects.toBeInstanceOf(ControlApiClientError);
          expect(f.selection.snapshot()[0]).toMatchObject({
            phase: "uncertain",
            retryable: true,
            receipt: null,
            input,
          });
          await expect(
            f.h.instances[0].services.invoke(
              PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
              { ...input, idempotencyKey: "replacement-key" },
              {},
            ),
          ).rejects.toThrow("intent_mismatch");
          expect(
            f.fetch.mock.calls.filter(([url]) =>
              String(url).endsWith("/actions"),
            ),
          ).toHaveLength(2);
        },
      );
      it.each(["wrong-category", "unknown-conflict", "malformed"] as const)(
        "an initial %s 409 does not infer a pre-COMMIT refusal",
        async (mode) => {
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
          f.reply(
            controlUiResponse(
              {
                error: {
                  ...(mode === "malformed"
                    ? {}
                    : {
                        category:
                          mode === "wrong-category" ? "internal" : "conflict",
                        requestId: "first-unproved",
                      }),
                  code:
                    mode === "unknown-conflict"
                      ? "concept_selection_receipt_conflict"
                      : "concept_selection_revision_conflict",
                  message: "Unproved",
                },
              },
              409,
            ),
          );
          await expect(
            f.h.instances[0].services.invoke(
              PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
              selectionJournalInput(),
              {},
            ),
          ).rejects.toThrow();
          expect(f.selection.snapshot()[0]).toMatchObject({
            phase: "uncertain",
            retryable: true,
            receipt: null,
          });
        },
      );
    },
  );
