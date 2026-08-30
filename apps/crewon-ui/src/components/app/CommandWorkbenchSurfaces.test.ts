// @ts-expect-error Vitest runs this contract in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeWorkbenchBrowserUrl } from "./CommandWorkbenchBrowser";
import {
  highlightWorkbenchCode,
  workbenchCodeLanguage,
} from "./CommandWorkbenchCode";
import { workbenchFileContent } from "./CommandWorkbenchFiles";
import { parseWorkbenchDiff } from "./CommandWorkbenchReview";

describe("workbench resize pointer capture", () => {
  /*
   * `setPointerCapture` throws for pointers the engine no longer considers
   * active. It used to run before `setResizing(true)`, so the throw aborted the
   * whole handler: `data-resizing` never went up, the page iframe kept taking
   * pointer events, and dragging the workbench edge did nothing once a browser
   * tab was open. Capture has to stay best-effort.
   */
  it("keeps a failed capture from aborting the drag", () => {
    const source = readFileSync(
      new URL("./CommandWorkspaceCapabilityDrawer.tsx", import.meta.url),
      "utf8",
    );
    const down = source.slice(
      source.indexOf("function handleResizePointerDown"),
      source.indexOf("function handleResizePointerMove"),
    );
    const finish = source.slice(
      source.indexOf("function finishResize"),
      source.indexOf("function handleResizeKeyDown"),
    );

    for (const [label, body, call] of [
      ["pointerdown", down, "setPointerCapture"],
      ["finish", finish, "releasePointerCapture"],
    ] as const) {
      const guardAt = body.indexOf("try {");
      expect(guardAt, `${label} must guard ${call}`).toBeGreaterThan(-1);
      expect(body.indexOf(call)).toBeGreaterThan(guardAt);
      // The state update has to be reachable even when capture throws.
      expect(body.indexOf("setResizing")).toBeGreaterThan(body.indexOf("}"));
    }
  });
});

describe("workbench tool launcher", () => {
  it("opens the tool menu from every tab without nesting it in the scroll strip", () => {
    const drawerSource = readFileSync(
      new URL("./CommandWorkspaceCapabilityDrawer.tsx", import.meta.url),
      "utf8",
    );
    const browserSource = readFileSync(
      new URL("./CommandWorkbenchBrowser.tsx", import.meta.url),
      "utf8",
    );
    const tabbar = drawerSource.slice(
      drawerSource.indexOf('<header className="command-workbench-tabbar">'),
      drawerSource.indexOf(
        '<div className="command-workbench-window-actions">',
      ),
    );

    expect(tabbar).toContain("onClick={toggleLauncher}");
    expect(tabbar).not.toContain('activeTab?.toolId === "web"');
    expect(tabbar.indexOf("command-workbench-launcher-menu")).toBeGreaterThan(
      tabbar.indexOf('className="command-workbench-tabs"'),
    );
    expect(tabbar.indexOf("command-workbench-launcher-menu")).toBeGreaterThan(
      tabbar.indexOf('className="command-workbench-launcher-anchor"'),
    );
    expect(drawerSource).toContain(
      "!launcherMenuRef.current?.contains(event.target as Node)",
    );
    expect(drawerSource).toContain("workbenchOverlayOpen={launcherOpen}");
    expect(drawerSource).toContain("obscured={workbenchOverlayOpen}");
    expect(browserSource).toContain("obscured={menuOpen || obscured}");
  });
});

describe("command workbench surfaces", () => {
  it("normalizes browser addresses while rejecting unsafe schemes", () => {
    expect([
      normalizeWorkbenchBrowserUrl("openai.com"),
      normalizeWorkbenchBrowserUrl("localhost:5175/health"),
      normalizeWorkbenchBrowserUrl("javascript:alert(1)"),
      normalizeWorkbenchBrowserUrl(""),
    ]).toEqual([
      "https://openai.com/",
      "http://localhost:5175/health",
      null,
      null,
    ]);
  });

  it("separates file metadata from the editor content", () => {
    expect(
      workbenchFileContent({
        body: "类型: 文件\n修改: 2026-08-05\n\nconst ready = true;\n",
        subtitle: "/repo/app.ts",
        title: "app.ts",
      }),
    ).toBe("const ready = true;\n");
  });

  it("renders extension-aware syntax tokens for the file editor", () => {
    expect(workbenchCodeLanguage("/repo/src/main.py")).toBe("python");
    expect(
      highlightWorkbenchCode(
        'from pathlib import Path\nready = Path("README.md").exists()',
        "/repo/src/main.py",
      ),
    ).toMatchInlineSnapshot(
      `"<span class=\"hljs-keyword\">from</span> pathlib <span class=\"hljs-keyword\">import</span> Path\nready = Path(<span class=\"hljs-string\">&quot;README.md&quot;</span>).exists()"`,
    );
  });

  it("splits a git diff into complete per-file review models", () => {
    expect(
      parseWorkbenchDiff(
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "diff --git a/src/b.ts b/src/b.ts",
          "--- a/src/b.ts",
          "+++ b/src/b.ts",
          "+second",
        ].join("\n"),
      ),
    ).toEqual([
      {
        body: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
        path: "src/a.ts",
      },
      {
        body: "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n+second",
        path: "src/b.ts",
      },
    ]);
  });
});
