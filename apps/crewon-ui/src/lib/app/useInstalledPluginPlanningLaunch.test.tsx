// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  subscribeDesktopLocalManagementAccess,
  type DesktopLocalManagementAccess,
} from "../desktop/desktopLocalManagementAccess";
import { useInstalledPluginPlanningLaunch } from "./useInstalledPluginPlanningLaunch";
import { planningLaunchFixture } from "../plugins/projectPlanningLaunch.test-support";
import {
  controlUiClient,
  controlUiResponse,
} from "../plugins/controlPluginUi.test-support";
import { createControlPluginUiHost } from "../plugins/controlPluginUiHost";
import { deferred } from "../plugins/pluginUiLoader.test-support";
const time = "2026-10-06T00:00:00.000Z";
const initialLocation = location.href;
afterEach(() => {
  vi.unstubAllGlobals();
  location.href = initialLocation;
});
describe("original App planning launch composition", () => {
  for (const scenario of [
    "execute",
    "active",
    "legacy",
    "changedWhileValidating",
    "native",
    "nativeWithdrawn",
    "untrustedNative",
    "nativeWeb",
    "signedOutWeb",
  ])
    it(`uses the real authenticated Control client and installed mount owner: ${scenario}`, async () => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      localStorage.clear();
      const nativeScenario =
        scenario.startsWith("native") || scenario === "untrustedNative";
      const originalUrl = location.href;
      let localManagementAccess: DesktopLocalManagementAccess | null = null;
      let stopNative = () => {};
      if (nativeScenario) {
        vi.stubGlobal("window", {
          crewonDesktop: {
            version: 1,
            runtime: {
              localManagementAccess: async () => ({
                schemaVersion: "crewon.desktop-local-management-access.v1",
                generation: 4,
              }),
              onLocalManagementAccessChanged: () => () => {},
            },
          },
        });
        stopNative = subscribeDesktopLocalManagementAccess((value) => {
          localManagementAccess = value;
        });
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(localManagementAccess).not.toBeNull();
        if (scenario === "untrustedNative")
          localManagementAccess = { ...localManagementAccess! };
      }
      const f = planningLaunchFixture(),
        gate = deferred<Response>(),
        seen: { path: string; method: string; body: unknown }[] = [];
      const clientFixture = controlUiClient(async (url, init) => {
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer captured-user-token",
        );
        const path = url.pathname,
          method = init.method ?? "GET",
          body = init.body ? JSON.parse(String(init.body)) : null;
        seen.push({ path, method, body });
        if (method !== "GET")
          expect(new Headers(init.headers).get("x-csrf-token")).toBe(
            "captured-csrf-token",
          );
        if (path === "/api/v1/runs/original-run")
          return controlUiResponse({
            run: {
              runId: "original-run",
              threadId: "original-thread",
              status: scenario === "active" ? "running" : "completed",
              revision: 1,
              lastSequence: 1,
              cancelRequested: false,
              waitingApproval: null,
              collaborationMode: "default",
              purpose: "turn",
              workflowVersionBinding: null,
              goalBinding: null,
              outputRef: null,
              failure: null,
              createdAt: time,
              updatedAt: time,
              terminalAt: scenario === "active" ? null : time,
            },
          });
        if (path.endsWith("/active-run"))
          return controlUiResponse({
            schemaVersion: "crewon.thread-active-run.v0",
            threadId: "original-thread",
            run: null,
          });
        if (path === "/api/v1/threads/original-thread")
          return controlUiResponse({
            eventSequence: 7,
            thread: {
              threadId: "original-thread",
              title: "原想法",
              status: "active",
              revision: 7,
              lastMessageSequence: 3,
              workspaceId: "original-workspace",
              createdAt: time,
              updatedAt: time,
              archivedAt: null,
              deletedAt: null,
              forkedFromThreadId: null,
              forkedThroughHistorySequence: null,
            },
          });
        if (path === "/api/v1/plugins/ui/mounts")
          return controlUiResponse(f.lease);
        if (path.endsWith("/actions"))
          return controlUiResponse({ output: await f.response(body) });
        if (path.endsWith(f.lease.mountRef) && method === "DELETE")
          return controlUiResponse({ closed: true });
        if (path.endsWith(f.lease.mountRef))
          return scenario === "changedWhileValidating"
            ? gate.promise
            : controlUiResponse(f.lease);
        throw new Error(`unexpected_transport:${method}:${path}`);
      });
      const scope = {
          client: clientFixture.client,
          sessionKey:
            nativeScenario || scenario === "signedOutWeb"
              ? null
              : "actual-user",
        },
        host = createControlPluginUiHost({
          client: scope.client,
          assertCurrent: () => undefined,
          onDiagnostic: () => undefined,
        });
      if (nativeScenario && scenario !== "nativeWeb")
        location.href = "file:///isolated/CrewON.app/dist/index.html";
      let currentScope: typeof scope | null = scope,
        currentThread = "original-thread";
      const module =
        scenario === "legacy"
          ? {
              ...f.module,
              plugin: {
                ...f.module.plugin,
                descriptor: {
                  ...f.module.plugin.descriptor,
                  requires: f.module.plugin.descriptor.requires.filter(
                    (r) =>
                      r.service !== "crewon.project-conversation-association",
                  ),
                },
              },
            }
          : f.module;
      const catalog = {
        fingerprint: "actual-source",
        plugins: [module.plugin],
        modules: [module],
      };
      let launch: ReturnType<
        typeof useInstalledPluginPlanningLaunch<typeof scope>
      > = null;
      const root = createRoot(document.createElement("div"));
      function Probe() {
        launch = useInstalledPluginPlanningLaunch({
          scope: currentScope,
          host,
          catalog,
          threadId: currentThread,
          localManagementAccess,
          assertScopeCurrent: (candidate) => {
            if (candidate !== currentScope) throw new Error("scope_changed");
          },
        });
        return null;
      }
      try {
        await act(async () => root.render(<Probe />));
        expect(seen).toHaveLength(0);
        if (
          scenario === "untrustedNative" ||
          scenario === "signedOutWeb" ||
          scenario === "nativeWeb"
        ) {
          expect(launch).toBeNull();
          return;
        }
        if (scenario === "legacy") {
          expect(launch!.supports(f.proposal)).toBe(false);
          expect(seen).toHaveLength(0);
          return;
        }
        if (scenario === "nativeWithdrawn") stopNative();
        const started = launch!.confirm(f.proposal, {
          mode: "execute",
          adoption: "manual",
        });
        void started.catch(() => undefined);
        if (scenario === "changedWhileValidating") {
          for (
            let i = 0;
            i < 100 &&
            !seen.some(
              (r) => r.method === "GET" && r.path.endsWith(f.lease.mountRef),
            );
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 5));
          currentThread = "another-thread";
          await act(async () => root.render(<Probe />));
          gate.resolve(controlUiResponse(f.lease));
          await expect(started).rejects.toThrow("context_changed");
        } else if (scenario === "nativeWithdrawn")
          await expect(started).rejects.toThrow("context_changed");
        else if (scenario === "active")
          await expect(started).rejects.toThrow("wait_for_turn");
        else await started;
        const mutations = seen.filter(
          (r) =>
            r.path.endsWith("/actions") &&
            /\.(createProject|attach|start)$/u.test(
              (r.body as { action: string }).action,
            ),
        );
        expect(mutations).toHaveLength(
          scenario === "execute" || scenario === "native" ? 3 : 0,
        );
        if (scenario === "execute" || scenario === "native") {
          const storageKey = localStorage.key(0)!;
          expect(storageKey).toContain(
            scenario === "native" ? "desktop-local-management" : "actual-user",
          );
          if (scenario === "native")
            expect(storageKey).not.toContain(scope.client.requestOrigin);
          expect(
            seen.find((r) => r.path === "/api/v1/plugins/ui/mounts")?.body,
          ).toEqual({
            pluginId: f.lease.descriptor.pluginId,
            contributionId: "workbench",
            expectedSelectionRevision: f.lease.selectionRevision,
            expectedPackageDigest: f.lease.packageDigest,
          });
          expect(
            mutations.map((r) => (r.body as { action: string }).action),
          ).toEqual([
            "crewon.creative-projects.v1.createProject",
            "crewon.project-conversation-association.v1.attach",
            "crewon.project-text-plans.v1.start",
          ]);
        }
        expect(
          seen.filter(
            (r) =>
              r.method === "POST" &&
              (r.path === "/api/v1/threads" || r.path.includes("/turns")),
          ),
        ).toHaveLength(0);
      } finally {
        await act(async () => root.unmount());
        stopNative();
        vi.unstubAllGlobals();
        location.href = originalUrl;
        localStorage.clear();
      }
    });
});
