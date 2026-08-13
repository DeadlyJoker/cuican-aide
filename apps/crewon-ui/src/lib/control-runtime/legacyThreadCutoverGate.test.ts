// @ts-expect-error Vitest runs this architecture gate in Node.
import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { selectThreadRuntimeAuthority } from "./threadRuntimeAuthority";

const CUT_OVER_METHODS = [
  "archiveThread",
  "clearThreadGoal",
  "compactThread",
  "deleteThread",
  "forkThread",
  "interruptTurn",
  "listThreads",
  "readThread",
  "renameThread",
  "rollbackThread",
  "setThreadGoal",
  "startThread",
  "startTurn",
  "unarchiveThread",
] as const;

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source(path),
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function callsIn(file: ts.SourceFile): string[] {
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      calls.push(node.expression.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

describe("legacy Thread cutover gate", () => {
  it("keeps the production composition free of the legacy authority selector", () => {
    const app = parse("../../App.tsx");
    const calls = callsIn(app);
    const appSource = source("../../App.tsx");

    expect(appSource).not.toMatch(
      /selectThreadRuntimeAuthority|legacyRuntime|clientRef/u,
    );
    expect(appSource).toMatch(
      /createAppThreadRuntimeHandlers\(\{[\s\S]*?client: threadRuntimeClient,/u,
    );

    const directLegacyCalls = calls.filter((call) =>
      CUT_OVER_METHODS.some((method) => call === `clientRef.current.${method}`),
    );
    expect(directLegacyCalls).toEqual([]);
  });

  it("uses AST calls so comments and user-facing strings are not findings", () => {
    const fixture = ts.createSourceFile(
      "fixture.ts",
      '// clientRef.current.startThread()\nconst text = "clientRef.current.deleteThread()";',
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      ts.ScriptKind.TS,
    );

    expect(callsIn(fixture)).toEqual([]);
  });

  it("dispatches the complete cut-over family only to Control in production selection", async () => {
    const legacyCalls: string[] = [];
    const legacy = new Proxy(
      {},
      {
        get:
          (_target, property) =>
          (..._args: unknown[]) => {
            legacyCalls.push(String(property));
            throw new Error("legacy_rpc_called");
          },
      },
    );
    const control = Object.fromEntries(
      CUT_OVER_METHODS.map((method) => [
        method,
        vi.fn(async (..._args: unknown[]) => null),
      ]),
    ) as Record<
      (typeof CUT_OVER_METHODS)[number],
      ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<null>>>
    >;
    const selected = selectThreadRuntimeAuthority({
      controlClientConfigured: true,
      controlConnected: true,
      controlRuntime: control,
      legacyConnected: true,
      legacyConnectionState: "connected",
      legacyRuntime: legacy,
    });

    const invocations: Record<(typeof CUT_OVER_METHODS)[number], unknown[]> = {
      archiveThread: ["thread-1"],
      clearThreadGoal: ["thread-1", { expectedRevision: 1 }],
      compactThread: ["thread-1"],
      deleteThread: ["thread-1"],
      forkThread: ["thread-1"],
      interruptTurn: ["thread-1", "run-1"],
      listThreads: [false],
      readThread: ["thread-1"],
      renameThread: ["thread-1", "renamed"],
      rollbackThread: ["thread-1", 1],
      setThreadGoal: ["thread-1", { objective: "ship", tokenBudget: null }],
      startThread: [],
      startTurn: ["thread-1", "do it", [], { executionIntent: "plan" }],
      unarchiveThread: ["thread-1"],
    };
    expect(selected.client).toBe(control);
    const selectedClient = selected.client as typeof control;
    for (const method of CUT_OVER_METHODS) {
      await selectedClient[method](...invocations[method]);
    }

    expect(legacyCalls).toEqual([]);
    for (const method of CUT_OVER_METHODS) {
      expect(control[method]).toHaveBeenCalledOnce();
    }
  });

  it("fails closed when configured Control is unavailable", () => {
    const selected = selectThreadRuntimeAuthority({
      controlClientConfigured: true,
      controlConnected: false,
      controlRuntime: null,
      legacyConnected: true,
      legacyConnectionState: "connected",
      legacyRuntime: { startThread: vi.fn() },
    });

    expect(selected).toEqual({
      client: null,
      connected: false,
      connectionState: "connecting",
      legacyManagesThreads: false,
    });
  });

  it("keeps the explicit legacy-only cohort operational", async () => {
    const startThread = vi.fn().mockResolvedValue({ id: "legacy-thread" });
    const legacy = { startThread };
    const selected = selectThreadRuntimeAuthority({
      controlClientConfigured: false,
      controlConnected: false,
      controlRuntime: null,
      legacyConnected: true,
      legacyConnectionState: "connected",
      legacyRuntime: legacy,
    });

    await selected.client?.startThread();
    expect(startThread).toHaveBeenCalledOnce();
    expect(selected.legacyManagesThreads).toBe(true);
  });
});
