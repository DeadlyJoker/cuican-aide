// @ts-expect-error Vitest runs this architecture test in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("App Workspace Control composition", () => {
  it("derives the sidebar workspace nav only from Control and native authority", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("controlWorkspaceNav={");
    const end = source.indexOf("capabilityDrawer={{", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const composition = source.slice(start, end);
    expect(source).toContain("useControlWorkspaceRuntime({");
    expect(source).toContain(
      "client: controlRuntimeConnected ? controlClient : null",
    );
    expect(source).toMatch(
      /nativeAuthority:\s*controlClient === null\s*\? null\s*:\s*desktopWorkspaceAuthority\(\)/u,
    );
    expect(source).toContain(
      "rehydrateThreadAuthority: rehydrateControlThreadAuthority",
    );
    expect(composition).toContain(
      "name: controlWorkspace.nativeWorkspace?.displayName ?? null",
    );
    expect(composition).toContain("controlClient === null");
    expect(composition).toContain("? null");
    expect(composition).toContain(
      'controlWorkspace.mutationAuthority === "desktop"',
    );
    expect(composition).not.toMatch(
      /readWorkspaceFiles|attachWorkspaceContext|clientRef|\bcwd\b|\bplatform\b/u,
    );
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

  it("keeps the online PIM workbench usable before a Thread is created", () => {
    const source = readFileSync(
      new URL(
        "../control-runtime/useControlSandboxCapabilities.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("if (params.client === null)");
    expect(source).not.toContain("params.selectedThreadId === null");
    expect(source).toContain('threadId ?? "draft"');
    expect(source).toContain("client.listSandboxDirectory(threadId");
    expect(source).toContain("client.runSandboxCommand(threadId");
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

  it("keeps the Control Goal snapshot authoritative when legacy transport is unavailable", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("threadGoal: controlThreadGoal");
    expect(source).toContain(
      'workspaceUiAuthority === "control" ? controlThreadGoal : threadGoal',
    );
    expect(source).toContain("threadGoal={authoritativeThreadGoal}");
  });

  it("routes every command scene through the Control runtime", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("manageThreads: true");
    expect(source).toContain('const workspaceUiAuthority = "control" as const');
    expect(source).toContain("enabled: false");
    expect(source).toContain(
      'controlThreadAuthority: workspaceUiAuthority === "control"',
    );
    expect(source).not.toContain("preferLegacyCodingRuntime");
    expect(source).not.toContain("useAppCommandModelOptions({");
  });

  it("rebuilds App Server notification handlers across scene authority changes", () => {
    const source = readFileSync(
      new URL("./useAppServerEventHandlerSet.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("[params.controlThreadAuthority]");
  });
});
