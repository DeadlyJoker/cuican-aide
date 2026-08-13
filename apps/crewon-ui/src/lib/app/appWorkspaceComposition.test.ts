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
    expect(source).toContain("export function App({ controlClient }");
    expect(source).toContain("client: null");
    expect(source).toContain("scheduleClient={null}");
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
    const routeEnd = source.indexOf("return (\n    <AppShellChromeFrame", routeStart);
    expect(source.slice(routeStart, routeEnd)).not.toContain("onAttachContext=");
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
