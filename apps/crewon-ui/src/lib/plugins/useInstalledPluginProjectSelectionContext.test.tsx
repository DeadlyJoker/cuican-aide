// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInstalledPluginProjectSelectionContext } from "./useInstalledPluginProjectSelectionContext";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import {
  selectionJournalFixture,
  selectionContextModule,
  selectionJournalReceipt,
} from "./installedPluginProjectSelection.test-support";
import { flush } from "./pluginUiLoader.test-support";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Input = Parameters<typeof useInstalledPluginProjectSelectionContext>[0];
describe("selection recovery hints", () => {
  let f: ReturnType<typeof selectionJournalFixture>,
    input: Input,
    state: ReturnType<typeof useInstalledPluginProjectSelectionContext>,
    root: Root,
    container: HTMLDivElement;
  function Probe(props: Input) {
    state = useInstalledPluginProjectSelectionContext(props);
    return null;
  }
  async function render(patch: Partial<Input> = {}, strict = false) {
    input = { ...input, ...patch };
    await act(async () => {
      root.render(
        strict ? (
          <StrictMode>
            <Probe {...input} />
          </StrictMode>
        ) : (
          <Probe {...input} />
        ),
      );
      await flush();
    });
  }
  async function unknown() {
    await act(async () => {
      await f.journal
        .invoke({
          lease: f.lease,
          input: f.input,
          signal: f.caller.signal,
          request: async () => {
            throw new Error("reply lost");
          },
        })
        .catch(() => {});
    });
  }
  beforeEach(() => {
    f = selectionJournalFixture();
    input = {
      ports: { journal: f.journal, assertSessionCurrent: f.assertCurrent },
      module: selectionContextModule(),
      active: true,
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    f.journal.invalidate();
    container.remove();
  });
  it("publishes only recovery without a Thread, runtime, network reader or implicit request", async () => {
    await render({}, true);
    expect(state.context).toEqual({
      version: "crewon.project-generation-selection-host-context.v1",
      intent: null,
    });
    expect(Object.keys(input.ports!)).toEqual([
      "journal",
      "assertSessionCurrent",
    ]);
    expect(f.request).not.toHaveBeenCalled();
    await unknown();
    expect(state.context.intent).toEqual({
      request: f.input,
      phase: "uncertain",
      retryable: true,
      receipt: null,
    });
    await render({ active: false });
    expect(state.context.intent).toBeNull();
    await render({ active: true }, true);
    expect(state.context.intent?.request).toEqual(f.input);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("same-package regrant changes authority revision without losing the exact intent; changed package disables retry", async () => {
    await render();
    await unknown();
    await render({ module: selectionContextModule(8) });
    expect(state.context.intent).toMatchObject({
      request: f.input,
      retryable: true,
    });
    expect(f.journal.snapshot()[0].sourcePin.selectionRevision).toBe(1);
    const module = selectionContextModule(9);
    await render({
      module: {
        ...module,
        plugin: { ...module.plugin, packageDigest: `sha256:${"9".repeat(64)}` },
      },
    });
    expect(state.context.intent).toMatchObject({
      request: f.input,
      retryable: false,
    });
  });
  it("accepted immutable receipt stays a recovery hint rather than a current pointer", async () => {
    await render();
    await act(async () => {
      await f.journal.invoke({
        lease: f.lease,
        input: f.input,
        signal: f.caller.signal,
        request: async () => ({ output: selectionJournalReceipt(f.input) }),
      });
    });
    expect(state.context.intent).toMatchObject({
      phase: "accepted",
      retryable: false,
      receipt: selectionJournalReceipt(f.input),
    });
    expect(state.context).not.toHaveProperty("current");
    expect(state.context).not.toHaveProperty("selectionRevision");
  });
  it.each([
    "inactive",
    "missingPorts",
    "missingService",
    "wrongVersion",
  ] as const)("%s does not expose even existing recovery", async (mode) => {
    await unknown();
    const module = selectionContextModule();
    await render(
      mode === "inactive"
        ? { active: false }
        : mode === "missingPorts"
          ? { ports: null }
          : {
              module: {
                ...module,
                plugin: {
                  ...module.plugin,
                  descriptor: {
                    ...module.plugin.descriptor,
                    requires:
                      mode === "missingService"
                        ? []
                        : [
                            {
                              service: "crewon.project-generation-selections",
                              apiVersion: "2",
                              optional: true,
                            },
                          ],
                  },
                },
              },
            },
    );
    expect(state.context.intent).toBeNull();
  });
  it("session withdrawal purges old hints before replacement and withholds late receipt", async () => {
    await render();
    const call = f.journal.invoke({
      lease: f.lease,
      input: f.input,
      signal: f.caller.signal,
      request: f.request,
    });
    void call.catch(() => {});
    await act(async () => {
      await flush();
    });
    expect(state.context.intent?.phase).toBe("pending");
    await act(async () => {
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    });
    expect(state.context.intent).toBeNull();
    expect(f.journal.snapshot()).toEqual([]);
    f.gate.resolve({ output: selectionJournalReceipt() });
    await expect(call).rejects.toThrow();
    const replacement = selectionJournalFixture();
    await render({
      ports: {
        journal: replacement.journal,
        assertSessionCurrent: replacement.assertCurrent,
      },
    });
    expect(state.context.intent).toBeNull();
    replacement.journal.invalidate();
  });
  it("a revoked account is fenced even before its lifecycle event", async () => {
    await render();
    await unknown();
    f.revoke();
    await render();
    expect(state.context.intent).toBeNull();
    expect(f.journal.snapshot()).toEqual([]);
  });
});
