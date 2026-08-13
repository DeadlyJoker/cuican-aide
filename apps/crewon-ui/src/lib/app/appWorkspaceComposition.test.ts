// @ts-expect-error Vitest runs this architecture test in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("App Workspace Control composition", () => {
  it("does not compose the legacy App Server connection or authorities", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(
      /useAppConnectionEffects|selectThreadRuntimeAuthority|legacyDomainClientForAuthority|clientRef/u,
    );
    expect(source).not.toContain("./lib/app-server/");
    expect(source).not.toContain("AppServerClient");
    expect(source).toContain("export function App({ controlClient }");
    expect(source).toContain("client: null");
    expect(source).toContain("scheduleClient={null}");
  });

  it("has no development recovery route that restarts App Server", () => {
    const viteConfig = readFileSync(
      new URL("../../../vite.config.ts", import.meta.url),
      "utf8",
    );
    const reconnect = readFileSync(
      new URL(
        "../../components/app/commandOfficeCatalogReconnect.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(viteConfig).not.toMatch(/restart-app-server|crewon-app-server/iu);
    expect(reconnect).not.toMatch(/restart|app-server/iu);
  });

  it("keeps Control thread creation free of App Server transport semantics", () => {
    const actions = readFileSync(
      new URL("../thread/threadMessageActions.ts", import.meta.url),
      "utf8",
    );
    const handlers = readFileSync(
      new URL("./handlers/appThreadRuntimeHandlers.ts", import.meta.url),
      "utf8",
    );

    expect(actions).toContain('threadSource = "control-api"');
    expect(handlers).toContain('threadSource = "control-api"');
    expect(actions).not.toMatch(
      /AppServerRpcError|isAppServerConnectionLoss|app-server\/appServer/iu,
    );
  });

  it("keeps active App catalog consumers off the App Server module", () => {
    for (const path of [
      "../../lib/capability/workspaceCapabilityActions.ts",
      "../../lib/composer/composerSlashCommands.ts",
      "../../lib/settings/settingsCapabilityRefreshActions.ts",
      "../../lib/settings/settingsRuntimeRefreshActions.ts",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source).toContain("../shared/appsCatalog");
      expect(source).not.toMatch(/^import (?!type).*app-server/mu);
    }
  });

  it("does not compose null-client Workspace and Terminal handlers", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const unavailableWorkspaceCapability");
    expect(source).not.toContain("createAppWorkspaceCapabilityHandlers");
    expect(source).not.toContain("workspaceCapabilityHandlersForAuthority");
  });

  it("does not compose the disconnected App Server Provider resource hook", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useControlComposerResourceDiscovery");
    expect(source).not.toContain("useProviderResourceComposer");
    expect(source).not.toContain("providerResourceComposer");
  });

  it("routes Library interactions only through Control", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createControlLibraryPanelActionHandler");
    expect(source).toContain("openControlLibraryItem");
    expect(source).not.toContain("createAppLibraryOpenCoordinator");
    expect(source).not.toContain("createAppLibraryPanelDispatchCoordinator");
    expect(source).not.toContain("createAppOfficeRuntimeCoordinator");
    expect(source).not.toContain("createAppDomainActionCoordinator");
  });

  it("composes Settings from a non-null Control client", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("createAppSettingsCoordinator({");
    const end = source.indexOf("const {", start);
    const composition = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(composition).toContain("client: controlClient");
    expect(composition).not.toMatch(
      /client: null|AppServer|resolveBackendCwd|selectedThread|workspaceStatus/u,
    );
  });

  it("does not compose the legacy capability dispatcher or item client", () => {
    const source = readFileSync(
      new URL("./handlers/appCapabilityPanelHandlers.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(
      /capabilityPanelActionDispatcher|capabilityPanelItemActions|AppServer|app-server/u,
    );
    expect(source).toContain("threadLifecycleActionForActionId");
    expect(source).toContain("params.handleSettingsAction(actionId)");
    expect(source).toContain("params.onUnavailable()");
  });

  it("sources the packaged command target and model catalogs only from Control", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useControlCommandCatalog({");
    expect(source).toContain("executionTargetClient={null}");
    expect(source).toContain("controlExecutionCatalog={");
  });

  it("keeps account settings Control-only", () => {
    const source = readFileSync(
      new URL("../account/accountActions.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('"getAccountSnapshot" | "getLocalSettings"');
    expect(source).toContain("Control account unavailable");
    expect(source).not.toMatch(
      /AppServerClient|App Server|app-server|loginAccount|logoutAccount|getAccountRateLimits|getAccountUsage/u,
    );
  });

  it("derives the visible slot only from Control and native authority", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("workspaceOperations={");
    const end = source.indexOf("capabilityDrawer={{", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const composition = source.slice(start, end);
    expect(source).toContain("useControlWorkspaceRuntime({");
    expect(source).toContain(
      "client: controlRuntimeConnected ? controlClient : null",
    );
    expect(source).toContain("nativeAuthority: desktopWorkspaceAuthority()");
    expect(source).toContain(
      "rehydrateThreadAuthority: rehydrateControlThreadAuthority",
    );
    expect(composition).toContain("state: controlWorkspace.state");
    expect(composition).toContain(
      'controlWorkspace.mutationAuthority === "desktop"',
    );
    expect(composition).not.toMatch(
      /readWorkspaceFiles|attachWorkspaceContext|clientRef|\bcwd\b|\bplatform\b/u,
    );
    const routeStart = source.indexOf("<AppCommandShellRoute");
    const routeEnd = source.indexOf(
      "return (\n    <AppShellChromeFrame",
      routeStart,
    );
    expect(source.slice(routeStart, routeEnd)).not.toContain(
      "onAttachContext=",
    );
  });

  it("requires an explicit Workspace authority and has no URL authority fallback", () => {
    const source = readFileSync(
      new URL("../../components/app/CommandWorkspace.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("workspaceAuthority: CommandWorkspaceAuthority;");
    expect(source).toContain("workspaceAuthority,");
    expect(source).not.toContain('workspaceAuthority = "legacy"');
    expect(source).not.toContain("teamCwd");
  });

  it("keeps the hook free of legacy filesystem and AppServer fallbacks", () => {
    const source = readFileSync(
      new URL(
        "../control-runtime/useControlWorkspaceRuntime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("SAFE_WORKSPACE_LIST_MAX_ENTRIES = 200");
    expect(source).toContain('? "readOnly"');
    expect(source).toContain(
      "params.client === null ? null : params.selectedThreadId",
    );
    expect(source).not.toMatch(
      /AppServer|app-server|readWorkspaceFiles|path picker/iu,
    );
  });

  it("rehydrates Thread, Run, and Goal authority before Workspace recovery", () => {
    const source = readFileSync(
      new URL("../control-runtime/useControlThreadRuntime.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const rehydrateThreadAuthority");
    const end = source.indexOf("useEffect(() =>", start);
    const rehydrate = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(rehydrate).toContain("runtime.readThread(threadId)");
    expect(rehydrate).toContain("upsertThread(current, thread)");
    expect(rehydrate).toContain("runtime.selectThreadGoal(threadId)");
  });
});
