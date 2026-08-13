import { describe, expect, it } from "vitest";

import { normalizeWorkbenchBrowserUrl } from "./CommandWorkbenchBrowser";
import {
  highlightWorkbenchCode,
  workbenchCodeLanguage,
} from "./CommandWorkbenchCode";
import { workbenchFileContent } from "./CommandWorkbenchFiles";
import { parseWorkbenchDiff } from "./CommandWorkbenchReview";

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
