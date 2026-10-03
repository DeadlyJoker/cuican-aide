// @vitest-environment happy-dom
import { act, isValidElement, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import type { PluginUiCatalogItem } from "@crewon/contracts";
import type { PluginUiTheme } from "@crewon/plugin-sdk/ui";
import { useInstalledPluginModules } from "./useInstalledPluginModules";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import { notifyInstalledPluginSelectionChanged } from "../plugins/installedPluginChanges";
import type { InstalledPluginTaskPorts } from "../plugins/useInstalledPluginTaskContext.types";
import type { InstalledPluginGenerationPorts } from "../plugins/useInstalledPluginGenerationContext.types";
import type { createInstalledPluginTaskReceipts } from "../plugins/installedPluginTaskReceipts";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "../plugins/controlPluginUi.test-support";
import {
  deferred,
  flush,
  uiLease,
} from "../plugins/pluginUiLoader.test-support";

import type { InstalledPluginProjectQueryPorts } from "../plugins/useInstalledPluginProjectQueryContext";
import {
  queryJournalLease,
  queryJournalInput,
} from "../plugins/installedPluginProjectQuery.test-support";

import type { InstalledPluginProjectSelectionPorts } from "../plugins/useInstalledPluginProjectSelectionContext";
import {
  selectionJournalLease,
  selectionJournalInput,
  selectionJournalReceipt,
} from "../plugins/installedPluginProjectSelection.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Input = Parameters<typeof useInstalledPluginModules>[0];
type State = ReturnType<typeof useInstalledPluginModules>;
function item(
  pluginId: string,
  names: readonly string[] = ["workbench"],
): PluginUiCatalogItem {
  const original = uiLease();
  return controlUiItem({
    ...original,
    descriptor: {
      ...original.descriptor,
      pluginId,
      contributions: names.map((id) => ({
        id,
        title: `${pluginId} ${id}`,
        kind: "module",
        slot: "main.content",
      })),
    },
  });
}

describe("installed plugin directory App composition (real Control client)", () => {
  let root: Root;
  let container: HTMLDivElement;
  let state: State;
  let initialRootStyle: string | null;
  let initialRootTheme: string | null;
  let initialRootClass: string | null;
  function Probe(input: Input) {
    state = useInstalledPluginModules(input);
    return (
      <ul aria-label="Installed plugin entries">
        {state.hostModules.map((module) => (
          <li key={module.id}>
            <span>{module.label}</span>
            {typeof module.content === "function"
              ? module.content({ active: false })
              : module.content}
          </li>
        ))}
      </ul>
    );
  }
  async function render(
    client: ControlApiClient | null,
    input: Partial<Input> = {},
    strict = false,
  ) {
    const node = (
      <Probe
        client={client}
        sessionKey="existing-host-session"
        theme="light"
        locale="zh"
        {...input}
      />
    );
    await act(async () => {
      root.render(strict ? <StrictMode>{node}</StrictMode> : node);
      await flush();
    });
    await settle();
  }
  async function settle() {
    await act(async () => {
      await flush();
      await flush();
    });
  }
  async function refresh() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
  }
  function presentation() {
    const content = state.hostModules[0].content;
    if (typeof content !== "function")
      throw new Error("Expected host content callback");
    const node = content({ active: false });
    if (!isValidElement(node))
      throw new Error("Expected module composition element");
    return (node as ReactElement<{ theme: PluginUiTheme; locale: string }>)
      .props;
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    initialRootStyle = document.documentElement.getAttribute("style");
    initialRootTheme = document.documentElement.getAttribute("data-theme");
    initialRootClass = document.documentElement.getAttribute("class");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const [name, value] of [
      ["style", initialRootStyle],
      ["data-theme", initialRootTheme],
      ["class", initialRootClass],
    ] as const) {
      if (value === null) document.documentElement.removeAttribute(name);
      else document.documentElement.setAttribute(name, value);
    }
  });

  it("exposes all installed contributions while leaving every module inactive and every request authenticated", async () => {
    const wire = controlUiClient((url, init) => {
      expect(url.pathname).toBe("/api/v1/plugins/ui/catalog");
      expect(init.method).toBe("GET");
      return controlUiResponse({
        plugins: [item("example.a", ["one", "two"]), item("example.b")],
        next: null,
      });
    });
    await render(wire.client);
    expect(state.hostModules).toHaveLength(3);
    expect(new Set(state.hostModules.map((module) => module.id)).size).toBe(3);
    expect(container.textContent).toContain("example.a one");
    expect(container.textContent).toContain("example.a two");
    expect(container.querySelector("[data-plugin-content-slot]")).toBeNull();
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(wire.fetch.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer captured-user-token");
    expect(wire.fetch.mock.calls[0][1]?.credentials).toBe("include");
  });

  it("polls by fingerprint and preserves the original module array for an unchanged catalog", async () => {
    let current = item("example.a");
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [current], next: null }),
    );
    await render(wire.client);
    const original = state.hostModules;
    await refresh();
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    expect(state.hostModules).toBe(original);
    current = {
      ...current,
      selectionRevision: 2,
      packageDigest: `sha256:${"2".repeat(64)}`,
    };
    await refresh();
    expect(state.hostModules).not.toBe(original);
    expect(state.hostModules[0].id).toBe(original[0].id);
    const before = original[0].content;
    const after = state.hostModules[0].content;
    expect(typeof before).toBe("function");
    expect(typeof after).toBe("function");
    if (typeof before !== "function" || typeof after !== "function")
      throw new Error("Expected callback");
    expect((after({ active: false }) as ReactElement).key).not.toBe(
      (before({ active: false }) as ReactElement).key,
    );
  });

  it("withdraws immediately after a selection change and only republishes from a fresh authenticated directory", async () => {
    const updated = deferred<Response>();
    let changed = false;
    const wire = controlUiClient(() =>
      changed
        ? updated.promise
        : controlUiResponse({ plugins: [item("example.old")], next: null }),
    );
    await render(wire.client);
    expect(state.hostModules).toHaveLength(1);
    changed = true;
    await act(async () => notifyInstalledPluginSelectionChanged());
    expect(state.hostModules).toEqual([]);
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    updated.resolve(
      controlUiResponse({ plugins: [item("example.new")], next: null }),
    );
    await settle();
    expect(state.hostModules).toHaveLength(1);
    expect(container.textContent).toContain("example.new");
    expect(container.textContent).not.toContain("example.old");
    for (const [, init] of wire.fetch.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer captured-user-token",
      );
    }
  });

  it("ignores the old in-flight snapshot after a management mutation", async () => {
    const late = deferred<Response>();
    let reads = 0;
    const wire = controlUiClient(() => {
      reads++;
      if (reads === 2) return late.promise;
      return controlUiResponse({
        plugins: [item(reads === 1 ? "example.old" : "example.new")],
        next: null,
      });
    });
    await render(wire.client);
    await refresh();
    expect(reads).toBe(2);
    await act(async () => notifyInstalledPluginSelectionChanged());
    await settle();
    expect(container.textContent).toContain("example.new");
    late.resolve(
      controlUiResponse({ plugins: [item("example.stale")], next: null }),
    );
    await settle();
    expect(container.textContent).toContain("example.new");
    expect(container.textContent).not.toContain("example.stale");
  });

  it("follows empty pages with a next cursor and removes withdrawn modules on the next snapshot", async () => {
    let withdrawn = false;
    const wire = controlUiClient((url) => {
      if (withdrawn) return controlUiResponse({ plugins: [], next: null });
      return url.searchParams.has("afterPluginId")
        ? controlUiResponse({ plugins: [item("example.b")], next: null })
        : controlUiResponse({ plugins: [], next: "example.a" });
    });
    await render(wire.client);
    expect(state.hostModules).toHaveLength(1);
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    withdrawn = true;
    await refresh();
    expect(state.hostModules).toEqual([]);
    expect(container.textContent).toBe("");
  });

  it("fails closed on a refresh error, bounds diagnostics and restores the directory only from a successful new snapshot", async () => {
    let failing = false;
    const wire = controlUiClient(() =>
      failing
        ? controlUiResponse(
            { error: { code: "authorization_denied", message: "Denied" } },
            403,
          )
        : controlUiResponse({ plugins: [item("example.a")], next: null }),
    );
    await render(wire.client);
    expect(state.hostModules).toHaveLength(1);
    failing = true;
    await refresh();
    expect(state.hostModules).toEqual([]);
    expect(state.getDiagnostics()).toHaveLength(1);
    for (let index = 0; index < 17; index++) await refresh();
    expect(state.getDiagnostics()).toHaveLength(16);
    expect(
      state
        .getDiagnostics()
        .every(
          (diagnostic) =>
            diagnostic.length <= 1024 &&
            !diagnostic.includes("captured-user-token"),
        ),
    ).toBe(true);
    failing = false;
    await refresh();
    expect(state.hostModules).toHaveLength(1);
  });

  it("withdraws immediately on a session event and discards an old response even if bootstrap has not replaced the client", async () => {
    const pending = deferred<Response>();
    let calls = 0;
    const wire = controlUiClient(() =>
      ++calls === 1
        ? controlUiResponse({ plugins: [item("example.a")], next: null })
        : pending.promise,
    );
    await render(wire.client);
    const refreshing = act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await refreshing;
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    const oldSignal = wire.fetch.mock.calls[1][1]?.signal;
    act(() =>
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT)),
    );
    expect(state.hostModules).toEqual([]);
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(
      controlUiResponse({ plugins: [item("example.z")], next: null }),
    );
    await settle();
    await refresh();
    expect(state.hostModules).toEqual([]);
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    await render(wire.client, { sessionKey: "different-account-key" });
    expect(state.hostModules).toEqual([]);
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    const replacement = controlUiClient(() =>
      controlUiResponse({ plugins: [item("example.new")], next: null }),
    );
    await render(replacement.client, { sessionKey: "different-account-key" });
    expect(container.textContent).toContain("example.new");
  });

  it("clears on client replacement, rejects late old responses and exposes only the replacement client's directory", async () => {
    const oldResponse = deferred<Response>();
    const freshResponse = deferred<Response>();
    const old = controlUiClient(() => oldResponse.promise);
    const fresh = controlUiClient(() => freshResponse.promise);
    await render(old.client);
    expect(state.hostModules).toEqual([]);
    await render(fresh.client);
    expect(old.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    oldResponse.resolve(
      controlUiResponse({ plugins: [item("example.old")], next: null }),
    );
    await settle();
    expect(state.hostModules).toEqual([]);
    freshResponse.resolve(
      controlUiResponse({ plugins: [item("example.new")], next: null }),
    );
    await settle();
    expect(container.textContent).toContain("example.new");
    expect(container.textContent).not.toContain("example.old");
  });

  it("treats sessionKey changes as a new host lifecycle without using that key as an HTTP actor", async () => {
    const next = deferred<Response>();
    let calls = 0;
    const wire = controlUiClient(() =>
      ++calls === 1
        ? controlUiResponse({ plugins: [item("example.a")], next: null })
        : next.promise,
    );
    await render(wire.client);
    const original = state.hostModules;
    await render(wire.client, { sessionKey: "other-host-user" });
    expect(state.hostModules).toEqual([]);
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    expect(String(wire.fetch.mock.calls[1][0])).not.toContain(
      "other-host-user",
    );
    next.resolve(
      controlUiResponse({ plugins: [item("example.a")], next: null }),
    );
    await settle();
    expect(state.hostModules).not.toBe(original);
    expect(state.hostModules).toHaveLength(1);
  });

  it("withdraws on disconnection and never polls null clients, foreign origins or file renderers", async () => {
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [item("example.a")], next: null }),
    );
    await render(wire.client);
    await render(null);
    expect(state.hostModules).toEqual([]);
    await refresh();
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    const fetch = vi.fn();
    const foreign = new ControlApiClient({
      baseUrl: "https://other.test",
      fetch,
    });
    await render(foreign);
    expect(state.hostModules).toEqual([]);
    vi.stubGlobal(
      "location",
      new URL("file:///Applications/CrewON/index.html"),
    );
    await render(wire.client);
    await refresh();
    expect(state.hostModules).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  });

  it("reads existing root theme tokens without changing the host's classes, attributes or painted styles", async () => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.className = "original-host-appearance";
    document.documentElement.style.setProperty("--text", "#eeeeee");
    document.documentElement.style.setProperty("--surface", "#202020");
    document.documentElement.style.setProperty(
      "--private-account-token",
      "must stay host-only",
    );
    const before = {
      style: document.documentElement.getAttribute("style"),
      className: document.documentElement.className,
      theme: document.documentElement.dataset.theme,
    };
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [item("example.a")], next: null }),
    );
    await render(wire.client);
    expect(presentation().theme).toEqual({
      mode: "dark",
      tokens: { "--surface": "#202020", "--text": "#eeeeee" },
    });
    expect(Object.isFrozen(presentation().theme.tokens)).toBe(true);
    await refresh();
    expect(document.documentElement.getAttribute("style")).toBe(before.style);
    expect(document.documentElement.className).toBe(before.className);
    expect(document.documentElement.dataset.theme).toBe(before.theme);
    const previousModules = state.hostModules;
    act(() => {
      document.documentElement.dataset.theme = "light";
      document.documentElement.style.setProperty("--text", "#101010");
    });
    await settle();
    expect(presentation().theme.mode).toBe("light");
    expect(presentation().theme.tokens["--text"]).toBe("#101010");
    expect(presentation().theme.tokens).not.toHaveProperty(
      "--private-account-token",
    );
    expect(state.hostModules).not.toBe(previousModules);
    await render(wire.client, { locale: "en" });
    expect(presentation().locale).toBe("en");
    expect(wire.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses the additive native capability only for file renderers and withdraws it on account changes", async () => {
    vi.stubGlobal(
      "location",
      new URL("file:///Applications/CrewON/index.html"),
    );
    const assets = {
      version: 1 as const,
      adopt: vi.fn(),
      release: vi.fn(),
      invalidate: vi.fn(async () => {}),
    };
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: { version: 1, pluginUiAssets: assets },
    });
    try {
      const fetch = vi.fn(async () =>
        controlUiResponse({ plugins: [item("example.native")], next: null }),
      );
      const client = new ControlApiClient({
        baseUrl: "http://127.0.0.1:32100",
        fetch,
      });
      await render(client);
      expect(state.hostModules).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(assets.adopt).not.toHaveBeenCalled();
      act(() =>
        window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT)),
      );
      await settle();
      expect(state.hostModules).toEqual([]);
      expect(assets.invalidate).toHaveBeenCalledTimes(1);
      await refresh();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await render(null);
      Reflect.deleteProperty(window, "crewonDesktop");
    }
  });

  it("cancels obsolete StrictMode directory work and stops scheduled polling after unmount", async () => {
    const responses: ReturnType<typeof deferred<Response>>[] = [];
    const wire = controlUiClient(() => {
      const gate = deferred<Response>();
      responses.push(gate);
      return gate.promise;
    });
    await render(wire.client, {}, true);
    // StrictMode's first effect is cancelled before its queued HTTP dispatch. Any real obsolete request is aborted.
    expect(
      wire.fetch.mock.calls.filter(([, init]) => !init?.signal?.aborted),
    ).toHaveLength(1);
    for (const response of responses)
      response.resolve(
        controlUiResponse({ plugins: [item("example.a")], next: null }),
      );
    await settle();
    expect(state.hostModules).toHaveLength(1);
    const count = wire.fetch.mock.calls.length;
    await act(async () => root.unmount());
    // Keep afterEach's unmount valid by replacing this test's unmounted root.
    root = createRoot(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(wire.fetch).toHaveBeenCalledTimes(count);
  });

  it("keeps the formal task recovery owner usable after StrictMode reattachment and withdraws it on a session change", async () => {
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [item("example.a")], next: null }),
    );
    const runtime = { adoptExtensionTask: vi.fn(async () => {}) };
    await render(
      wire.client,
      {
        taskContext: {
          runtime,
          selectedThreadId: null,
          runIds: [],
          onOpenTask: vi.fn(),
        },
      },
      true,
    );
    const props = presentation() as ReturnType<typeof presentation> & {
      taskPorts: InstalledPluginTaskPorts;
    };
    expect(props.taskPorts).not.toBeNull();
    const source = props.taskPorts.receiptSource as ReturnType<
      typeof createInstalledPluginTaskReceipts
    >;
    const observed = vi.fn();
    const stop = source.subscribe(observed);
    source.observe({
      lease: uiLease(),
      receipt: {
        disposition: "committed",
        threadId: "thread-recovery",
        threadRevision: 2,
        runId: "run-recovery",
        messageId: "message-recovery",
        configurationRevision: 1,
      },
    });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(source.snapshot()).toHaveLength(1);
    expect(runtime.adoptExtensionTask).not.toHaveBeenCalled();
    expect(
      wire.fetch.mock.calls.every((call) => call[1]?.method === "GET"),
    ).toBe(true);
    act(() =>
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT)),
    );
    expect(() => props.taskPorts.assertSessionCurrent()).toThrow(
      "plugin_ui_session_changed",
    );
    expect(source.snapshot()).toEqual([]);
    expect(state.hostModules).toEqual([]);
    stop();
  });

  it("preserves a generation journal through StrictMode, appearance updates and runtime reconnection, then erases it on a real account change", async () => {
    const base = uiLease();
    const lease = {
      ...base,
      descriptor: {
        ...base.descriptor,
        requires: [
          {
            service: "crewon.project-generations",
            apiVersion: "1",
            optional: true,
          },
          {
            service: "crewon.project-generation-contexts",
            apiVersion: "1",
            optional: true,
          },
        ],
      },
    };
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [controlUiItem(lease)], next: null }),
    );
    const onOpenTask = vi.fn();
    const runtime = { adoptExtensionTask: vi.fn(async () => {}) };
    const taskContext = {
      runtime,
      selectedThreadId: null,
      runIds: [],
      onOpenTask,
    };
    await render(wire.client, { taskContext }, true);
    const ports = () =>
      (
        presentation() as ReturnType<typeof presentation> & {
          generationPorts: InstalledPluginGenerationPorts;
        }
      ).generationPorts;
    const original = ports();
    const input = {
      reference: {
        projectId: "project",
        assetId: "asset",
        assetRevision: 1,
        expectedProjectRevision: 3,
        expectedAssetMetadataRevision: 1,
      },
      threadId: "thread",
      expectedThreadRevision: 1,
      idempotencyKey: "original-generation-key",
    };
    const physical = deferred<{
      output: {
        disposition: string;
        threadId: string;
        threadRevision: number;
        runId: string;
        messageId: string;
        configurationRevision: number;
      };
    }>();
    const caller = new AbortController();
    const pending = original.journal.invoke({
      lease,
      input,
      signal: caller.signal,
      request: () => physical.promise,
    });
    await flush();
    caller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(original.journal.snapshot()[0].phase).toBe("uncertain");
    await render(
      wire.client,
      { taskContext, theme: "dark", locale: "en" },
      true,
    );
    expect(ports().journal).toBe(original.journal);
    const nextRuntime = { adoptExtensionTask: vi.fn(async () => {}) };
    await render(
      wire.client,
      { taskContext: { ...taskContext, runtime: nextRuntime } },
      true,
    );
    expect(ports().journal).toBe(original.journal);
    expect(() => original.assertSessionCurrent()).not.toThrow();
    expect(() => original.onOpenTask("thread")).toThrow(
      "plugin_ui_session_changed",
    );
    physical.resolve({
      output: {
        disposition: "committed",
        threadId: "thread",
        threadRevision: 2,
        runId: "accepted-run",
        messageId: "accepted-message",
        configurationRevision: 1,
      },
    });
    await settle();
    expect(original.journal.snapshot()[0].phase).toBe("accepted");
    expect(runtime.adoptExtensionTask).not.toHaveBeenCalled();
    expect(nextRuntime.adoptExtensionTask).not.toHaveBeenCalled();
    const taskPorts = (
      presentation() as ReturnType<typeof presentation> & {
        taskPorts: InstalledPluginTaskPorts;
      }
    ).taskPorts;
    expect(taskPorts.receiptSource.snapshot()).toEqual([]);
    act(() =>
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT)),
    );
    expect(original.journal.snapshot()).toEqual([]);
    expect(() => original.assertSessionCurrent()).toThrow(
      "plugin_ui_session_changed",
    );
  });

  it("keeps an unresolved generation key while the installed source pin changes and blocks replacing it", async () => {
    const base = uiLease();
    const lease = {
      ...base,
      descriptor: {
        ...base.descriptor,
        requires: [
          {
            service: "crewon.project-generations",
            apiVersion: "1",
            optional: true,
          },
          {
            service: "crewon.project-generation-contexts",
            apiVersion: "1",
            optional: true,
          },
        ],
      },
    };
    let catalog = controlUiItem(lease);
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [catalog], next: null }),
    );
    const runtime = { adoptExtensionTask: vi.fn(async () => {}) };
    const taskContext = {
      runtime,
      selectedThreadId: null,
      runIds: [],
      onOpenTask: vi.fn(),
    };
    await render(wire.client, { taskContext });
    const ports = () =>
      (
        presentation() as ReturnType<typeof presentation> & {
          generationPorts: InstalledPluginGenerationPorts;
        }
      ).generationPorts;
    const original = ports().journal;
    const input = {
      reference: {
        projectId: "project",
        assetId: "asset",
        assetRevision: 1,
        expectedProjectRevision: 3,
        expectedAssetMetadataRevision: 1,
      },
      threadId: "thread",
      expectedThreadRevision: 1,
      idempotencyKey: "original-key",
    };
    await expect(
      original.invoke({
        lease,
        input,
        signal: new AbortController().signal,
        request: async () => {
          throw new Error("sent outcome unknown");
        },
      }),
    ).rejects.toThrow("sent outcome unknown");
    const replacement = {
      ...lease,
      selectionRevision: 2,
      packageDigest: `sha256:${"2".repeat(64)}`,
    };
    catalog = controlUiItem(replacement);
    await refresh();
    expect(ports().journal).toBe(original);
    expect(original.current({ lease: replacement })?.input.idempotencyKey).toBe(
      "original-key",
    );
    expect(original.current({ lease: replacement })?.retryable).toBe(false);
    expect(() =>
      original.register({
        lease: replacement,
        input: { ...input, idempotencyKey: "replacement-key" },
      }),
    ).toThrow();
    expect(
      wire.fetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
  it("keeps query recovery independent of generation through remount and purges it before an account replacement", async () => {
    const lease = queryJournalLease();
    let catalog = controlUiItem(lease);
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [catalog], next: null }),
    );
    const runtime = { adoptExtensionTask: vi.fn(async () => {}) };
    const taskContext = {
      runtime,
      selectedThreadId: null,
      runIds: [],
      onOpenTask: vi.fn(),
    };
    await render(wire.client, { taskContext }, true);
    const ports = () =>
      presentation() as ReturnType<typeof presentation> & {
        projectQueryPorts: InstalledPluginProjectQueryPorts;
        generationPorts: InstalledPluginGenerationPorts;
      };
    const query = ports().projectQueryPorts.journal;
    const generation = ports().generationPorts.journal;
    const input = queryJournalInput();
    await expect(
      query.invoke({
        lease,
        input,
        signal: new AbortController().signal,
        request: async () => {
          throw new Error("sent query outcome unknown");
        },
      }),
    ).rejects.toThrow("sent query outcome unknown");
    expect(generation.snapshot()).toEqual([]);
    catalog = controlUiItem({
      ...lease,
      selectionRevision: 2,
      packageDigest: `sha256:${"2".repeat(64)}`,
    });
    await refresh();
    expect(ports().projectQueryPorts.journal).toBe(query);
    expect(
      query.current({
        lease: {
          ...lease,
          selectionRevision: 2,
          packageDigest: catalog.packageDigest,
        },
      })?.retryable,
    ).toBe(false);
    await act(async () =>
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT)),
    );
    expect(state.hostModules).toEqual([]);
    expect(query.snapshot()).toEqual([]);
    expect(() => query.register({ lease, input })).toThrow(
      "plugin_ui_project_query_journal_inactive",
    );
    const replacement = controlUiClient(() =>
      controlUiResponse({ plugins: [controlUiItem(lease)], next: null }),
    );
    await render(replacement.client, {
      taskContext,
      sessionKey: "replacement-account",
    });
    expect(ports().projectQueryPorts.journal).not.toBe(query);
    expect(ports().projectQueryPorts.journal.snapshot()).toEqual([]);
    expect(
      wire.fetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
    expect(
      replacement.fetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
  it("assembles selection recovery without a task context, runtime or Thread and retains it through StrictMode, theme and catalog regrant", async () => {
    const lease = selectionJournalLease();
    let catalog = controlUiItem(lease);
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [catalog], next: null }),
    );
    await render(wire.client, {}, true);
    const ports = () =>
      presentation() as ReturnType<typeof presentation> & {
        selectionPorts: InstalledPluginProjectSelectionPorts;
        projectQueryPorts: InstalledPluginProjectQueryPorts | null;
        generationPorts: InstalledPluginGenerationPorts | null;
      };
    expect(ports().projectQueryPorts).toBeNull();
    expect(ports().generationPorts).toBeNull();
    const journal = ports().selectionPorts.journal,
      input = selectionJournalInput();
    await journal
      .invoke({
        lease,
        input,
        signal: new AbortController().signal,
        request: async () => {
          throw new Error("sent selection unknown");
        },
      })
      .catch(() => {});
    await render(
      wire.client,
      {
        theme: "dark",
        locale: "en",
        taskContext: {
          runtime: null,
          selectedThreadId: null,
          runIds: [],
          onOpenTask: vi.fn(),
        },
      },
      true,
    );
    expect(ports().selectionPorts.journal).toBe(journal);
    catalog = controlUiItem({ ...lease, selectionRevision: 8 });
    await refresh();
    expect(ports().selectionPorts.journal).toBe(journal);
    expect(
      journal.current({ lease: { ...lease, selectionRevision: 8 } }),
    ).toMatchObject({
      input,
      phase: "uncertain",
      retryable: true,
      sourcePin: { selectionRevision: 1 },
    });
    expect(
      wire.fetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
    await act(async () =>
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT)),
    );
    expect(state.hostModules).toEqual([]);
    expect(journal.snapshot()).toEqual([]);
    const replacement = controlUiClient(() =>
      controlUiResponse({ plugins: [controlUiItem(lease)], next: null }),
    );
    await render(replacement.client, { sessionKey: "replacement-account" });
    expect(ports().selectionPorts.journal).not.toBe(journal);
    expect(ports().selectionPorts.journal.snapshot()).toEqual([]);
    expect(
      replacement.fetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
  it("a changed session key fences a selection's physical reply before any replacement journal can expose it", async () => {
    const lease = selectionJournalLease();
    const wire = controlUiClient(() =>
      controlUiResponse({ plugins: [controlUiItem(lease)], next: null }),
    );
    await render(wire.client);
    const ports = () =>
      presentation() as ReturnType<typeof presentation> & {
        selectionPorts: InstalledPluginProjectSelectionPorts;
      };
    const journal = ports().selectionPorts.journal,
      gate = deferred<{ output: ReturnType<typeof selectionJournalReceipt> }>();
    const call = journal.invoke({
      lease,
      input: selectionJournalInput(),
      signal: new AbortController().signal,
      request: () => gate.promise,
    });
    void call.catch(() => {});
    await settle();
    expect(journal.snapshot()[0].phase).toBe("pending");
    await render(wire.client, { sessionKey: "another-account" });
    gate.resolve({ output: selectionJournalReceipt() });
    await expect(call).rejects.toThrow();
    expect(journal.snapshot()).toEqual([]);
    expect(ports().selectionPorts.journal).not.toBe(journal);
    expect(ports().selectionPorts.journal.snapshot()).toEqual([]);
    expect(
      wire.fetch.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
});
