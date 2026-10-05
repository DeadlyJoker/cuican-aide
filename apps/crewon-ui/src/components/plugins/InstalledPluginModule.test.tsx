// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { PluginUiTheme } from "@crewon/plugin-sdk/ui";
import { createControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import type { ControlPluginUiModule } from "../../lib/plugins/controlPluginUiCatalog";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "../../lib/plugins/controlPluginUi.test-support";
import {
  deferred,
  flush,
  uiHarness,
  uiLease,
} from "../../lib/plugins/pluginUiLoader.test-support";
import { InstalledPluginModule } from "./InstalledPluginModule";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { createInstalledPluginProjectSelectionJournal } from "../../lib/plugins/installedPluginProjectSelectionJournal";
import {
  selectionJournalLease,
  selectionJournalInput,
  selectionJournalReceipt,
} from "../../lib/plugins/installedPluginProjectSelection.test-support";

const roots: Root[] = [];
const light: PluginUiTheme = { mode: "light", tokens: { "--text": "#202020" } };
const dark: PluginUiTheme = { mode: "dark", tokens: { "--text": "#eeeeee" } };

async function settle() {
  for (let count = 0; count < 5; count++) await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
});

afterEach(async () => {
  for (const root of roots.splice(0))
    await act(async () => {
      root.unmount();
      await settle();
    });
  expect(vi.getTimerCount()).toBe(0);
  document.body.replaceChildren();
  vi.useRealTimers();
});

function fixture(
  selectionEnabled = false,
  options = { associationEnabled: false },
) {
  const h = uiHarness();
  const originalLease = selectionEnabled ? selectionJournalLease() : uiLease();
  const lease = options.associationEnabled
    ? {
        ...originalLease,
        descriptor: {
          ...originalLease.descriptor,
          requires: [
            ...originalLease.descriptor.requires,
            {
              service: "crewon.project-conversation-association",
              apiVersion: "1",
              optional: true,
            },
          ],
        },
      }
    : originalLease;
  const leases = new Map<string, PluginUiLease>();
  let serial = 0;
  let revoked = false;
  let current = true;
  let openGate: ReturnType<typeof deferred<Response>> | null = null;
  let validationGate: ReturnType<typeof deferred<Response>> | null = null;
  const wire = controlUiClient((url, init) => {
    if (init.method === "DELETE") return controlUiResponse({ closed: true });
    if (init.method === "POST" && url.pathname.endsWith("/actions"))
      return controlUiResponse({ output: { accepted: true } });
    if (init.method === "POST") {
      const opened = { ...lease, mountRef: uiLease(++serial).mountRef };
      leases.set(opened.mountRef, opened);
      const gate = openGate;
      openGate = null;
      return gate?.promise ?? controlUiResponse(opened);
    }
    const gate = validationGate;
    validationGate = null;
    if (gate) return gate.promise;
    if (revoked)
      return controlUiResponse(
        {
          error: {
            code: "plugin_ui_mount_unavailable",
            message: "Revoked mount",
          },
        },
        409,
      );
    const mountRef = url.pathname.split("/").at(-1)!;
    return controlUiResponse(leases.get(mountRef));
  });
  const diagnostic = vi.fn();
  const importer = vi.fn(
    async (_url: string): Promise<unknown> => ({ default: h.definition }),
  );
  const selectionJournal = createInstalledPluginProjectSelectionJournal({
    assertCurrent() {
      if (!current) throw new Error("fixture_session_revoked");
    },
    onDiagnostic: diagnostic,
  });
  const selectionPorts = {
    journal: selectionJournal,
    assertSessionCurrent() {
      if (!current) throw new Error("fixture_session_revoked");
    },
  };
  const host = createControlPluginUiHost({
    client: wire.client,
    assertCurrent() {
      if (!current) throw new Error("fixture_session_revoked");
    },
    importer,
    ...(selectionEnabled ? { selectionJournal } : {}),
    onDiagnostic: diagnostic,
  });
  const module: ControlPluginUiModule = {
    key: JSON.stringify([lease.descriptor.pluginId, lease.contributionId]),
    mountKey: JSON.stringify([
      lease.descriptor.pluginId,
      lease.contributionId,
      lease.selectionRevision,
      lease.packageDigest,
    ]),
    title: "测试工作台",
    contributionId: lease.contributionId,
    plugin: controlUiItem(lease),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (
    active: boolean,
    theme = light,
    locale: "zh" | "en" = "zh",
    onDiagnostic: (error: unknown) => void = diagnostic,
    currentModule = module,
    selectedThreadId: string | null = null,
  ) => {
    await act(async () => {
      root.render(
        <InstalledPluginModule
          host={host}
          module={currentModule}
          active={active}
          theme={theme}
          locale={locale}
          onDiagnostic={onDiagnostic}
          selectedThreadId={selectedThreadId}
          {...(selectionEnabled ? { selectionPorts } : {})}
        />,
      );
      await settle();
    });
  };
  const requests = (method: string) =>
    wire.fetch.mock.calls.filter(([, init]) => init?.method === method);
  return {
    ...wire,
    h,
    lease,
    host,
    module,
    container,
    render,
    importer,
    diagnostic,
    selectionJournal,
    requests,
    opened: () =>
      requests("POST").filter(([url]) => !String(url).endsWith("/actions")),
    closed: () => requests("DELETE"),
    revoke: () => {
      revoked = true;
    },
    allow: () => {
      revoked = false;
    },
    revokeSession: () => {
      current = false;
    },
    gateOpen: (gate: ReturnType<typeof deferred<Response>>) => {
      openGate = gate;
    },
    gateValidation: (gate: ReturnType<typeof deferred<Response>>) => {
      validationGate = gate;
    },
  };
}

describe("installed module composition (real authenticated host, explicit importer fixture)", () => {
  it("updates the current ordinary Thread pointer in the existing mount without creating an association", async () => {
    const f = fixture(false, { associationEnabled: true });
    await f.render(
      true,
      light,
      "zh",
      f.diagnostic,
      f.module,
      "ordinary-thread-1",
    );
    expect(f.h.instances).toHaveLength(1);
    expect(f.container.textContent).toContain(
      '"projectConversationAssociationThreadId":"ordinary-thread-1"',
    );
    await f.render(
      true,
      light,
      "zh",
      f.diagnostic,
      f.module,
      "ordinary-thread-2",
    );
    expect(f.h.instances).toHaveLength(1);
    expect(f.container.textContent).toContain(
      '"projectConversationAssociationThreadId":"ordinary-thread-2"',
    );
    await f.render(true, light, "zh", f.diagnostic, f.module, null);
    expect(f.container.textContent).toContain(
      '"projectConversationAssociationThreadId":null',
    );
    expect(
      f.requests("POST").filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(0);
    expect(f.h.instances[0]!.dispose).not.toHaveBeenCalled();
  });

  it("keeps the new conversation pointer absent for an older plugin declaration", async () => {
    const f = fixture();
    await f.render(
      true,
      light,
      "zh",
      f.diagnostic,
      f.module,
      "ordinary-thread-1",
    );
    expect(f.container.textContent).not.toContain(
      "projectConversationAssociationThreadId",
    );
    expect(
      f.requests("POST").filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(0);
  });

  it("publishes a false-to-true ready update and permits the first invocation only after real activation", async () => {
    const f = fixture();
    const seen: boolean[] = [];
    let invocation: Promise<unknown> | null = null;
    f.importer.mockImplementation(async () => ({
      default: {
        ...f.h.definition,
        mount(
          root: HTMLElement,
          props: Parameters<typeof f.h.definition.mount>[1],
          services: Parameters<typeof f.h.definition.mount>[2],
        ) {
          seen.push((props.data as { pluginUiReady: boolean }).pluginUiReady);
          const instance = f.h.definition.mount(root, props, services);
          return {
            async update(next: Parameters<typeof f.h.definition.mount>[1]) {
              const ready = (next.data as { pluginUiReady: boolean })
                .pluginUiReady;
              seen.push(ready);
              if (ready && !invocation)
                invocation = services.invoke("query", null, {});
              return (await instance).update(next);
            },
            async dispose() {
              return (await instance).dispose();
            },
          };
        },
      },
    }));
    await f.render(true);
    expect(seen[0]).toBe(false);
    expect(seen).toContain(true);
    await expect(invocation).resolves.toEqual({ accepted: true });
    expect(
      f.requests("POST").filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(1);
    await f.render(true, dark);
    expect(
      f.requests("POST").filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(1);
  });

  it("loads only an active module, updates host props, and closes every lease when leaving", async () => {
    const f = fixture();
    const originalTheme = document.documentElement.dataset.theme;
    const originalStyle = document.documentElement.getAttribute("style");
    await f.render(false);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.importer).not.toHaveBeenCalled();
    expect(f.container.textContent).toBe("");
    await f.render(true);
    expect(f.opened()).toHaveLength(1);
    expect(f.importer).toHaveBeenCalledWith(
      `/api/v1/plugins/ui/mounts/${f.lease.mountRef}/assets/ui/index.js`,
    );
    expect(f.container.querySelector('[role="status"]')).toBeNull();
    expect(f.container.querySelector('[role="alert"]')).toBeNull();
    const instance = f.h.instances[0];
    expect(instance.props).toEqual({
      schemaVersion: "crewon.plugin-ui-props.v1",
      contributionId: "workbench",
      theme: light,
      data: { locale: "zh", pluginUiReady: false },
    });
    expect(instance.update.mock.calls.at(-1)?.[0].data).toEqual({
      locale: "zh",
      pluginUiReady: true,
    });
    await f.render(true, dark, "en");
    expect(f.opened()).toHaveLength(1);
    expect(f.importer).toHaveBeenCalledTimes(1);
    expect(instance.update.mock.calls.at(-1)?.[0]).toEqual({
      ...instance.props,
      theme: dark,
      data: { locale: "en", pluginUiReady: true },
    });
    await f.render(true, dark, "en", f.diagnostic, {
      ...f.module,
      plugin: { ...f.module.plugin },
    });
    expect(f.opened()).toHaveLength(1);
    expect(f.h.instances).toHaveLength(1);
    expect(instance.dispose).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe(originalTheme);
    expect(document.documentElement.getAttribute("style")).toBe(originalStyle);
    await f.render(false);
    expect(f.closed()).toHaveLength(1);
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    await expect(instance.services.invoke("query", null, {})).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    expect(vi.getTimerCount()).toBe(0);
    await f.render(true);
    expect(f.opened()).toHaveLength(2);
    expect(f.h.instances).toHaveLength(2);
    expect(f.container.querySelector('[role="status"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("closes a late allocated lease without interfering with the newly active generation", async () => {
    const f = fixture();
    const open = deferred<Response>();
    f.gateOpen(open);
    await f.render(true);
    expect(f.container.querySelector('[role="status"]')).not.toBeNull();
    expect(f.importer).not.toHaveBeenCalled();
    await f.render(false);
    await f.render(true);
    const child = f.container.querySelector("[data-plugin-ui-root]");
    expect(child).not.toBeNull();
    expect(f.h.instances).toHaveLength(1);
    open.resolve(controlUiResponse(f.lease));
    await act(settle);
    expect(f.closed().map(([url]) => String(url))).toEqual([
      `${location.origin}/api/v1/plugins/ui/mounts/${f.lease.mountRef}`,
    ]);
    expect(f.container.querySelector("[data-plugin-ui-root]")).toBe(child);
    expect(f.container.querySelector('[role="status"]')).toBeNull();
    expect(f.importer).toHaveBeenCalledTimes(1);
    expect(f.diagnostic).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("rechecks a changed publication pin even if the contribution and package mount key stay the same", async () => {
    const f = fixture();
    await f.render(true);
    const instance = f.h.instances[0];
    await f.render(true, light, "zh", f.diagnostic, {
      ...f.module,
      plugin: { ...f.module.plugin, publicAssets: ["ui/index.js"] },
    });
    // The response still carries the old publication subset; the real host must reject it.
    expect(f.opened()).toHaveLength(2);
    expect(f.importer).toHaveBeenCalledTimes(1);
    expect(f.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(f.container.querySelector("[data-plugin-ui-root]")).toBeNull();
    expect(f.closed()).toHaveLength(2);
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    expect(f.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "plugin_ui_lease_identity_mismatch",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withdraws a revoked lease during polling and only retries after explicit reentry", async () => {
    const f = fixture();
    await f.render(true);
    const instance = f.h.instances[0];
    f.revoke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    });
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
      "模块暂时不可用",
    );
    expect(f.container.querySelector("[data-plugin-ui-root]")).toBeNull();
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    expect(f.closed()).toHaveLength(1);
    await expect(instance.services.invoke("query", null, {})).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    expect(f.diagnostic).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    f.allow();
    await f.render(true, dark);
    expect(f.opened()).toHaveLength(1);
    expect(f.container.querySelector('[role="alert"]')).not.toBeNull();
    await f.render(false);
    await f.render(true, dark);
    expect(f.opened()).toHaveLength(2);
    expect(f.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("aborts an awaited poll on leaving and ignores its late result after reopening", async () => {
    const f = fixture();
    await f.render(true);
    const poll = deferred<Response>();
    f.gateValidation(poll);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    });
    const checking = f.fetch.mock.calls.at(-1)![1]!.signal!;
    expect(checking.aborted).toBe(false);
    await f.render(false);
    expect(checking.aborted).toBe(true);
    await f.render(true);
    const child = f.container.querySelector("[data-plugin-ui-root]");
    poll.reject(new Error("late old poll failure"));
    await act(settle);
    expect(f.diagnostic).not.toHaveBeenCalled();
    expect(f.container.querySelector('[role="alert"]')).toBeNull();
    expect(f.container.querySelector("[data-plugin-ui-root]")).toBe(child);
    expect(f.opened()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("closes an importer failure and does not keep polling the failed module", async () => {
    const f = fixture();
    f.importer.mockRejectedValueOnce(new Error("fixture import failed"));
    await f.render(true);
    expect(f.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(f.container.querySelector('[role="status"]')).toBeNull();
    expect(f.h.instances).toHaveLength(0);
    expect(f.closed()).toHaveLength(1);
    expect(f.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ message: "fixture import failed" }),
    );
    expect(vi.getTimerCount()).toBe(0);
    await f.render(false);
    await f.render(true);
    expect(f.h.instances).toHaveLength(1);
    expect(f.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("continues revocation and cleanup when host diagnostics throw", async () => {
    const f = fixture();
    const onDiagnostic = vi.fn(() => {
      throw new Error("fixture diagnostic failed");
    });
    await f.render(true, light, "zh", onDiagnostic);
    f.revoke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(f.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(f.container.querySelector("[data-plugin-ui-root]")).toBeNull();
    expect(f.h.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(f.closed()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("publishes selection recovery only in module data without adding host controls or changing styles, and recovers through reopening", async () => {
    const f = fixture(true),
      style = document.documentElement.getAttribute("style"),
      theme = document.documentElement.dataset.theme;
    await f.render(true);
    const initial = JSON.parse(f.container.textContent!);
    expect(initial.projectGenerationSelectionContext).toEqual({
      version: "crewon.project-generation-selection-host-context.v1",
      intent: null,
    });
    const shape = () =>
      [...f.container.querySelectorAll("*")].map((node) => [
        node.tagName,
        node.getAttribute("class"),
        node.getAttribute("role"),
      ]);
    const originalShape = shape();
    await act(async () => {
      await f.selectionJournal
        .invoke({
          lease: f.lease,
          input: selectionJournalInput(),
          signal: new AbortController().signal,
          request: async () => {
            throw new Error("lost reply");
          },
        })
        .catch(() => {});
      await settle();
    });
    expect(
      JSON.parse(f.container.textContent!).projectGenerationSelectionContext
        .intent,
    ).toMatchObject({
      phase: "uncertain",
      request: selectionJournalInput(),
      retryable: true,
    });
    expect(shape()).toEqual(originalShape);
    expect(f.container.querySelector("button")).toBeNull();
    await f.render(false);
    await f.render(true, dark, "en");
    expect(
      JSON.parse(f.container.textContent!).projectGenerationSelectionContext
        .intent.request,
    ).toEqual(selectionJournalInput());
    expect(
      f.requests("POST").filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(0);
    await act(async () => {
      await f.selectionJournal.invoke({
        lease: f.lease,
        input: selectionJournalInput(),
        signal: new AbortController().signal,
        request: async () => ({ output: selectionJournalReceipt() }),
      });
      await settle();
    });
    const data = JSON.parse(f.container.textContent!);
    expect(data.projectGenerationSelectionContext.intent).toMatchObject({
      phase: "accepted",
      receipt: selectionJournalReceipt(),
      retryable: false,
    });
    expect(data.projectGenerationSelectionContext).not.toHaveProperty(
      "current",
    );
    expect(document.documentElement.getAttribute("style")).toBe(style);
    expect(document.documentElement.dataset.theme).toBe(theme);
  });
});
