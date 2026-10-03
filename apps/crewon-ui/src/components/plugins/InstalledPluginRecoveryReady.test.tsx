// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
import type { ControlPluginUiModule } from "../../lib/plugins/controlPluginUiCatalog";
import {
  recoveryHint,
  recoveryHostFixture,
  recoveryRequests,
  recoveryResponse,
} from "../../lib/plugins/installedPluginUiRecovery.test-support";
import { deferred, flush } from "../../lib/plugins/pluginUiLoader.test-support";
import { controlUiResponse } from "../../lib/plugins/controlPluginUi.test-support";
import { InstalledPluginModule } from "./InstalledPluginModule";
import { uiRecord } from "../../lib/plugins/pluginUiValidation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
async function settle() {
  for (let index = 0; index < 3; index++) await flush();
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await act(async () => {
      root.unmount();
      await settle();
    });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function fixture() {
  const f = recoveryHostFixture(),
    observed: PluginUiProps[] = [];
  f.importer.mockImplementation(async () => ({
    default: {
      ...f.h.definition,
      mount(root, props, services) {
        observed.push(props);
        const mounted = f.h.definition.mount(root, props, services);
        if (mounted instanceof Promise)
          throw new Error("named_sync_fixture_required");
        return {
          dispose: mounted.dispose,
          update(next: PluginUiProps) {
            observed.push(next);
            return mounted.update(next);
          },
        };
      },
    },
  }));
  const module: ControlPluginUiModule = {
    key: JSON.stringify([f.lease.descriptor.pluginId, f.lease.contributionId]),
    mountKey: "recovery-current-mount",
    title: "Recovery fixture",
    contributionId: f.lease.contributionId,
    plugin: {
      descriptor: f.lease.descriptor,
      packageDigest: f.lease.packageDigest,
      selectionRevision: f.lease.selectionRevision,
      publicAssets: f.lease.publicAssets,
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const runtime = { adoptExtensionTask: vi.fn(async () => undefined) },
    onOpenTask = vi.fn();
  const render = async () =>
    act(async () => {
      root.render(
        <InstalledPluginModule
          host={f.host}
          module={module}
          active
          locale="zh"
          theme={{ mode: "light", tokens: {} }}
          onDiagnostic={f.onDiagnostic}
          generationPorts={{
            client: f.client,
            runtime,
            journal: f.generationJournal,
            assertSessionCurrent: f.assertCurrent,
            onOpenTask,
          }}
          projectQueryPorts={{
            client: f.client,
            runtime,
            journal: f.projectQueryJournal,
            assertSessionCurrent: f.assertCurrent,
            onOpenTask,
          }}
          selectionPorts={{
            journal: f.selectionJournal,
            assertSessionCurrent: f.assertCurrent,
          }}
        />,
      );
      await settle();
    });
  return { ...f, observed, root, container, render };
}

describe("actual installed module recovery readiness", () => {
  it("the first pluginUiReady props contain all original lane requests, with no pre-hydration import or automatic mutation", async () => {
    const f = fixture(),
      gate = deferred<Response>();
    f.setRead(() => gate.promise);
    await f.render();
    expect(f.importer).not.toHaveBeenCalled();
    expect(f.observed).toEqual([]);
    expect(f.container.textContent).toContain("正在加载模块");
    await act(async () => {
      gate.resolve(
        controlUiResponse(
          recoveryResponse(
            recoveryRequests.map((request) => recoveryHint(request)),
          ),
        ),
      );
      await settle();
    });
    const ready = f.observed.find(
      (props) => uiRecord(props.data).pluginUiReady === true,
    );
    expect(ready).toBeDefined();
    const data = uiRecord(ready!.data);
    expect(data.projectGenerationContext).toMatchObject({
      intent: { request: recoveryRequests[0].input, phase: "uncertain" },
    });
    expect(data.projectGenerationQueryContext).toMatchObject({
      intent: { request: recoveryRequests[1].input, phase: "uncertain" },
    });
    expect(data.projectGenerationSelectionContext).toMatchObject({
      intent: { request: recoveryRequests[2].input, phase: "uncertain" },
    });
    expect(f.wire("/actions")).toHaveLength(0);
    expect(f.wire("/recovery")).toHaveLength(1);
    expect(
      f.fetch.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/threads") && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("GET failure displays the existing unavailable message and never emits ready or mounts plugin UI", async () => {
    const f = fixture();
    f.setRead(() =>
      controlUiResponse(
        {
          error: {
            category: "internal",
            code: "recovery_unavailable",
            requestId: "ready-read-failure",
          },
        },
        503,
      ),
    );
    await f.render();
    await act(settle);
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
      "模块暂时不可用",
    );
    expect(f.importer).not.toHaveBeenCalled();
    expect(f.observed).toEqual([]);
    expect(f.wire("/actions")).toHaveLength(0);
  });
});
