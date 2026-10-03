// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import {
  PROJECT_GENERATION_UI_ACTIONS,
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import { createControlPluginUiHost } from "./controlPluginUiHost";
import { createDesktopPluginUiHost } from "./desktopPluginUiHost";
import {
  createInstalledPluginGenerationJournal,
  type InstalledPluginGenerationJournal,
} from "./installedPluginGenerationJournal";
import {
  generationJournalInput,
  generationJournalLease,
  generationJournalReceipt,
} from "./installedPluginGenerationJournal.test-support";
import {
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import { desktopPluginUiAssetUrl } from "../desktop/desktopPluginUiProtocol";
import {
  deferred,
  flush,
  uiHarness,
  uiProps,
} from "./pluginUiLoader.test-support";
import type { PluginUiMountHandle } from "./trustedPluginUiLoader";

const handles: PluginUiMountHandle[] = [];
const journals: InstalledPluginGenerationJournal[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  for (const journal of journals.splice(0)) journal.invalidate();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
type Surface = "web" | "native";
function fixture(
  surface: Surface,
  options: {
    lease?: PluginUiLease;
    journal?: InstalledPluginGenerationJournal;
    account?: { current: boolean };
    withJournal?: boolean;
    actionResponse?: () => Promise<Response> | Response;
  } = {},
) {
  vi.stubGlobal(
    "location",
    surface === "web"
      ? { protocol: "http:", origin: "http://127.0.0.1:32100" }
      : { protocol: "file:", origin: "null" },
  );
  const lease = options.lease ?? generationJournalLease(),
    h = uiHarness();
  const account = options.account ?? { current: true };
  const assertCurrent = () => {
    if (!account.current) throw new Error("captured_account_changed");
  };
  const observer = vi.fn(),
    onDiagnostic = vi.fn();
  const journal =
    options.journal ??
    createInstalledPluginGenerationJournal({ assertCurrent, onDiagnostic });
  if (!options.journal) journals.push(journal);
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/actions"))
      return (
        options.actionResponse?.() ??
        controlUiResponse({ output: generationJournalReceipt() })
      );
    return controlUiResponse(
      init?.method === "DELETE" ? { closed: true } : lease,
    );
  });
  const client = new ControlApiClient({
    baseUrl: "http://127.0.0.1:32100",
    accessToken: "captured-generation-user-token",
    csrfToken: "captured-generation-csrf",
    fetch,
  });
  const bindingRef = "c".repeat(64);
  const assets = {
    version: 1 as const,
    adopt: vi.fn(async () => ({
      bindingRef,
      entryUrl: desktopPluginUiAssetUrl(bindingRef, "ui/index.js"),
      controlOrigin: client.requestOrigin,
    })),
    release: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
  };
  const common = {
    client,
    assertCurrent,
    onDiagnostic,
    onTaskReceipt: observer,
    generationJournal: options.withJournal === false ? undefined : journal,
    importer: async () => ({ default: h.definition }),
  };
  const host =
    surface === "web"
      ? createControlPluginUiHost(common)
      : createDesktopPluginUiHost({ ...common, assets });
  const mount = async () => {
    const mounted = await host.acquireMount(
      controlUiItem(lease),
      "workbench",
      new AbortController().signal,
    );
    const handle = await host.loader.mount({
      root: h.root,
      lease: mounted,
      props: uiProps(),
    });
    handles.push(handle);
    return handle;
  };
  const actions = () =>
    fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions"));
  return {
    lease,
    journal,
    host,
    h,
    observer,
    fetch,
    assets,
    account,
    mount,
    actions,
    revoke: () => {
      account.current = false;
    },
  };
}

for (const surface of ["web", "native"] as const)
  describe(`${surface} actual generation transport route`, () => {
    it("routes only exact generation to the journal and keeps confirmed cross-plugin receipts out of old task registry", async () => {
      const f = fixture(surface);
      await f.mount();
      await expect(
        f.h.instances[0].services.invoke(
          PROJECT_GENERATION_UI_ACTIONS[0],
          generationJournalInput(),
          {},
        ),
      ).resolves.toEqual(generationJournalReceipt());
      expect(f.journal.snapshot()[0]).toMatchObject({
        phase: "accepted",
        input: generationJournalInput(),
        receipt: generationJournalReceipt(),
      });
      expect(f.observer).not.toHaveBeenCalled();
      const sent = f.actions()[0];
      expect(JSON.parse(String(sent[1]?.body))).toEqual({
        action: PROJECT_GENERATION_UI_ACTIONS[0],
        input: generationJournalInput(),
      });
      expect(new Headers(sent[1]?.headers).get("authorization")).toBe(
        "Bearer captured-generation-user-token",
      );
      await expect(
        f.h.instances[0].services.invoke("original.tasks.request", null, {}),
      ).resolves.toEqual(generationJournalReceipt());
      expect(f.observer).toHaveBeenCalledExactlyOnceWith({
        lease: f.lease,
        receipt: generationJournalReceipt(),
      });
      expect(f.journal.snapshot()).toHaveLength(1);
    });

    it("missing journal rejects reserved generation before HTTP and never borrows the old task receipt path", async () => {
      const f = fixture(surface, { withJournal: false });
      await f.mount();
      await expect(
        f.h.instances[0].services.invoke(
          PROJECT_GENERATION_UI_ACTIONS[0],
          generationJournalInput(),
          {},
        ),
      ).rejects.toThrow("plugin_ui_generation_journal_unavailable");
      expect(f.actions()).toHaveLength(0);
      expect(f.observer).not.toHaveBeenCalled();
      expect(f.journal.snapshot()).toEqual([]);
    });

    it("unmount cancels the module while the account journal observes the original physical late commit", async () => {
      const gate = deferred<Response>(),
        f = fixture(surface, { actionResponse: () => gate.promise });
      const handle = await f.mount();
      const called = f.h.instances[0].services.invoke(
        PROJECT_GENERATION_UI_ACTIONS[0],
        generationJournalInput(),
        {},
      );
      const rejected = expect(called).rejects.toThrow(
        "plugin_ui_operation_aborted",
      );
      await flush();
      expect(f.actions()).toHaveLength(1);
      const physicalSignal = f.actions()[0][1]!.signal!;
      await handle.stop();
      await rejected;
      expect(physicalSignal.aborted).toBe(false);
      expect(f.journal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        physicallyPending: true,
        retryable: false,
      });
      gate.resolve(controlUiResponse({ output: generationJournalReceipt() }));
      await flush();
      expect(f.journal.snapshot()[0]).toMatchObject({
        phase: "accepted",
        physicallyPending: false,
        input: generationJournalInput(),
      });
      expect(f.observer).not.toHaveBeenCalled();
      expect(f.h.root.textContent).toBe("");
    });

    it("a new module realm and mount reuse the same account intent and physical request", async () => {
      const gate = deferred<Response>(),
        first = fixture(surface, { actionResponse: () => gate.promise });
      const handle = await first.mount();
      const called = first.h.instances[0].services.invoke(
        PROJECT_GENERATION_UI_ACTIONS[0],
        generationJournalInput(),
        {},
      );
      const cancelled = expect(called).rejects.toThrow(
        "plugin_ui_operation_aborted",
      );
      await flush();
      await handle.stop();
      await cancelled;
      const replacementLease = parsePluginUiLease({
        ...first.lease,
        mountRef: "replacement_" + "r".repeat(40),
      });
      const second = fixture(surface, {
        lease: replacementLease,
        journal: first.journal,
        account: first.account,
      });
      await second.mount();
      const joined = second.h.instances[0].services.invoke(
        PROJECT_GENERATION_UI_ACTIONS[0],
        generationJournalInput(),
        {},
      );
      await flush();
      expect(second.actions()).toHaveLength(0);
      gate.resolve(controlUiResponse({ output: generationJournalReceipt() }));
      await expect(joined).resolves.toEqual(generationJournalReceipt());
      expect(first.actions()).toHaveLength(1);
      expect(first.journal.snapshot()[0]).toMatchObject({
        phase: "accepted",
        input: generationJournalInput(),
      });
      expect(first.observer).not.toHaveBeenCalled();
      expect(second.observer).not.toHaveBeenCalled();
    });

    it("a replacement account never receives the old physical receipt or original creation holder", async () => {
      const gate = deferred<Response>(),
        f = fixture(surface, { actionResponse: () => gate.promise });
      await f.mount();
      f.journal.getOrCreatePreparationOwner(
        JSON.stringify(["example.workbench", "workbench"]),
        () => ({ idempotencyKey: "original-thread-key" }),
      );
      const called = f.h.instances[0].services.invoke(
        PROJECT_GENERATION_UI_ACTIONS[0],
        generationJournalInput(),
        {},
      );
      const rejected = expect(called).rejects.toThrow(
        "captured_account_changed",
      );
      await flush();
      f.revoke();
      gate.resolve(controlUiResponse({ output: generationJournalReceipt() }));
      await rejected;
      expect(f.journal.snapshot()).toEqual([]);
      expect(f.observer).not.toHaveBeenCalled();
      expect(() =>
        f.journal.getOrCreatePreparationOwner("new-account", () => ({})),
      ).toThrow();
    });

    it("an actual post-send HTTP refusal stays UNKNOWN with its original key", async () => {
      const f = fixture(surface, {
        actionResponse: () =>
          controlUiResponse(
            {
              error: { code: "conflict", message: "Unavailable after submit" },
            },
            409,
          ),
      });
      await f.mount();
      await expect(
        f.h.instances[0].services.invoke(
          PROJECT_GENERATION_UI_ACTIONS[0],
          generationJournalInput(),
          {},
        ),
      ).rejects.toThrow();
      expect(f.journal.snapshot()[0]).toMatchObject({
        phase: "uncertain",
        physicallyPending: false,
        retryable: true,
        input: generationJournalInput(),
      });
      expect(f.actions()).toHaveLength(1);
      expect(f.observer).not.toHaveBeenCalled();
    });
  });
