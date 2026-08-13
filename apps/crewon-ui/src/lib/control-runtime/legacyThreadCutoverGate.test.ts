// @ts-expect-error Vitest runs this architecture gate in Node.
import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

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

});
