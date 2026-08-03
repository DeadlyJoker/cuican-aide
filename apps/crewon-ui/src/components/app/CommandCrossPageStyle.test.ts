// @ts-expect-error Vitest runs this check in Node, while the browser bundle omits Node types.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { declaredProperties, scanRules } from "../../styles/deadRuleScanner";

function readStyles(file: string): string {
  return readFileSync(new URL(`../../styles/${file}`, import.meta.url), "utf8");
}

function readComponent(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

const SHELL_FILES = ["app.css", "original-shell-overrides.css"];

/*
 * Component-level stylesheets are easy to miss when auditing: the provider
 * picker kept a teal fill and a blue shadow long after the shells went neutral,
 * because a sweep over styles/ never reached it.
 */
function componentStyleFiles(): string[] {
  const root = new URL("../", import.meta.url);
  const found: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir));
      } else if (entry.name.endsWith(".css")) {
        found.push(new URL(entry.name, dir).pathname);
      }
    }
  };
  walk(root);
  return found;
}

function rulesOf(file: string) {
  return scanRules(readStyles(file));
}

/*
 * The feature pages drifted apart because each one hardcoded its own sizes and
 * shadows: a primary button was 28px on one page, 32px with 8px corners on
 * another, and the shadows carried a blue cast the command shell had already
 * dropped. These checks hold the shared scales in place.
 */
describe("cross-page control scale", () => {
  const CONTROL = new RegExp(
    [
      "\\.button(?![\\w-])",
      "\\.filter-chip",
      "\\.tab-button",
      "\\.mode-tab",
      "\\.select-trigger",
      "\\.icon-action",
    ].join("|"),
  );

  it("sizes every control from the height scale", () => {
    const offenders: string[] = [];

    for (const file of SHELL_FILES) {
      const source = readStyles(file);
      for (const rule of scanRules(source)) {
        if (!CONTROL.test(rule.selector)) continue;
        for (const match of rule.body.matchAll(/min-height:\s*([^;]+)/g)) {
          const value = match[1].trim();
          if (value.startsWith("var(--control-h-")) continue;
          // A percentage or auto is layout-driven, not a control size.
          if (/^(auto|100%|inherit|0)$/.test(value)) continue;
          const line = source.slice(0, rule.start).split("\n").length;
          offenders.push(`${file}:${line} ${rule.selector.slice(0, 52)} = ${value}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("cross-page elevation", () => {
  /*
   * Saturated shadows carry meaning and are exempt: green marks success, amber
   * marks warning, and a blue focus ring has to stay discernible for
   * accessibility. Only desaturated decorative shadows must use the tokens.
   */
  function saturation(r: number, g: number, b: number): number {
    const high = Math.max(r, g, b) / 255;
    const low = Math.min(r, g, b) / 255;
    if (high === low) return 0;
    const light = (high + low) / 2;
    return light > 0.5
      ? (high - low) / (2 - high - low)
      : (high - low) / (high + low);
  }

  function isDecorativeGrey(value: string): boolean {
    const colours = [
      ...value.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g),
    ];
    if (colours.length === 0) return false;
    return colours.every(([, r, g, b]) => {
      const [red, green, blue] = [Number(r), Number(g), Number(b)];
      if (saturation(red, green, blue) > 0.45) return false;
      return !(green > blue || red > blue + 4);
    });
  }

  it("draws decorative shadows from the elevation tokens", () => {
    const offenders: string[] = [];

    for (const file of SHELL_FILES) {
      const source = readStyles(file);
      for (const rule of scanRules(source)) {
        for (const match of rule.body.matchAll(/box-shadow:\s*([^;]+)/g)) {
          const value = match[1].replace(/\s+/g, " ").trim();
          if (value.includes("var(") || value === "none") continue;
          if (value.includes("inset")) continue;
          // A zero-blur spread is a ring, which the tokens do not describe.
          if (/(?:^|[\s,])-?[\d.]+(?:px)?\s+-?[\d.]+(?:px)?\s+0(?:px)?\s/.test(value)) {
            continue;
          }
          if (!isDecorativeGrey(value)) continue;
          const line = source.slice(0, rule.start).split("\n").length;
          offenders.push(`${file}:${line} ${value.slice(0, 46)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("declares each scale token once per theme it varies in", () => {
    const source = readStyles("app.css");
    const count = (name: string) =>
      source.split(new RegExp(`${name}:`)).length - 1;

    // Shadows are colours, so they need a light and a dark value. Heights are
    // geometry and stay the same in both themes, so one declaration is right.
    expect({
      "--shadow-raised": count("--shadow-raised"),
      "--shadow-overlay": count("--shadow-overlay"),
      "--shadow-modal": count("--shadow-modal"),
      "--shadow-drawer-left": count("--shadow-drawer-left"),
      "--control-h-sm": count("--control-h-sm"),
      "--control-h-md": count("--control-h-md"),
      "--control-h-lg": count("--control-h-lg"),
    }).toEqual({
      "--shadow-raised": 2,
      "--shadow-overlay": 2,
      "--shadow-modal": 2,
      "--shadow-drawer-left": 2,
      "--control-h-sm": 1,
      "--control-h-md": 1,
      "--control-h-lg": 1,
    });
  });
});

describe("component stylesheets", () => {
  it("paints decoration from tokens rather than literal colours", () => {
    const offenders: string[] = [];

    for (const path of componentStyleFiles()) {
      const source = readFileSync(path, "utf8");
      const name = path.split("/").slice(-1)[0];
      const lines: string[] = source.split("\n");
      for (const [index, line] of lines.entries()) {
        // A hex inside var(--token, #fallback) is a legitimate fallback.
        const bare = line.replace(/var\(--[\w-]+,\s*#[\da-fA-F]{3,8}\s*\)/g, "");
        const hex = bare.match(/#[\da-fA-F]{3,8}/);
        if (hex) offenders.push(`${name}:${index + 1} ${hex[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("draws shadows from the elevation tokens", () => {
    const offenders: string[] = [];

    for (const path of componentStyleFiles()) {
      const source = readFileSync(path, "utf8");
      const name = path.split("/").slice(-1)[0];
      for (const match of source.matchAll(/box-shadow:\s*([^;]+)/g)) {
        const value = match[1].replace(/\s+/g, " ").trim();
        if (value.includes("var(") || value === "none") continue;
        offenders.push(`${name} ${value.slice(0, 46)}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/*
 * The schedule page grew its own two tab strips -- an underline set and a boxed
 * set -- that shared nothing with the catalog tabs: 34px tall against 28px, its
 * own grey track, and a literal shadow. Both now render SegmentedTabs.
 */
describe("one segmented control", () => {
  it("routes page tab strips through the shared component", () => {
    const pages = new URL("./", import.meta.url);
    const offenders: string[] = [];

    for (const entry of readdirSync(pages)) {
      if (!entry.endsWith(".tsx") || entry.endsWith(".test.tsx")) continue;
      const source = readFileSync(new URL(entry, pages).pathname, "utf8");
      // A role="group" of buttons is a segmented control; it should be the
      // shared component rather than a hand-rolled strip.
      for (const match of source.matchAll(
        /className="([\w-]*tabs?[\w-]*)"[^>]*\n?\s*role="group"/g,
      )) {
        if (match[1] === "catalog-mode-tabs") continue;
        offenders.push(`${entry} .${match[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the strip styled in one place", () => {
    // A per-page tab class with its own height or fill is the drift to catch.
    const offenders: string[] = [];

    for (const file of SHELL_FILES) {
      const source = readStyles(file);
      for (const rule of scanRules(source)) {
        if (!/-(view|scope)-tabs\b/.test(rule.selector)) continue;
        const props = declaredProperties(rule.body);
        for (const own of ["min-height", "background", "box-shadow"]) {
          if (props.has(own)) {
            const line = source.slice(0, rule.start).split("\n").length;
            offenders.push(`${file}:${line} ${rule.selector.slice(0, 40)} ${own}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/*
 * Header rows drifted three ways at once. The tab strip sat in a `1fr` column,
 * so a 199px strip stretched to 915px and squeezed the actions column onto a
 * second row: 80px on agents and 84px on team against 42px on schedule. The
 * agents buttons were also `compact` (28px) beside a 32px search box, and the
 * schedule carried its 12px trailing gap as margin while the catalog pages count
 * it as padding, so its first content row sat 10px lower than everywhere else.
 */
describe("page header row", () => {
  it("sizes the tab column to its content, not the free space", () => {
    const offenders: string[] = [];

    for (const file of SHELL_FILES) {
      const source = readStyles(file);
      for (const rule of scanRules(source)) {
        if (rule.atRules.length > 0) continue;
        if (!/\.catalog-market-header$/.test(rule.selector)) continue;
        const columns = rule.body
          .match(/grid-template-columns:\s*([^;]+)/)?.[1]
          .trim();
        if (!columns) continue;
        // The strip comes first and must be content-sized; the actions column
        // takes the slack.
        if (!columns.startsWith("auto")) {
          const line = source.slice(0, rule.start).split("\n").length;
          offenders.push(`${file}:${line} ${columns}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps one control height across every header", () => {
    const source = readStyles("original-shell-overrides.css");
    const rule = scanRules(source).find(
      (candidate) =>
        candidate.selector ===
        ".shell-page-view .catalog-header-actions .button.compact",
    );

    // Without this the agents header renders 28px buttons beside a 32px search.
    expect(rule?.body).toContain("min-height: var(--control-h-md)");
  });

  it("carries the trailing gap the same way on every page", () => {
    const source = readStyles("original-shell-overrides.css");
    const rule = scanRules(source).find(
      (candidate) => candidate.selector === ".schedule-header",
    );

    // Padding, like the catalog headers, so the box height already includes it.
    expect(rule?.body).toContain("padding-bottom: 12px");
    expect(rule?.body).not.toMatch(/margin-bottom:/);
  });
});

/*
 * The schedule and team headers reflowed under @media (max-width: 980px) and
 * (860px). Neither ever matched: the window stays wide while the canvas shrinks
 * behind the workbench and sidebar, so those pages never responded at all.
 */
describe("header reflow is canvas-relative", () => {
  it("reflows page headers from container queries, not the viewport", () => {
    const source = readStyles("original-shell-overrides.css");
    const offenders: string[] = [];

    for (const rule of scanRules(source)) {
      const media = rule.atRules.find((at) => at.startsWith("@media"));
      if (!media) continue;
      if (!/-header(-actions)?\b|\.schedule-subnav\b/.test(rule.selector)) {
        continue;
      }
      // Reflow is the layout switch; colour and font tweaks are fine in @media.
      const props = declaredProperties(rule.body);
      const reflow = ["grid-template-columns", "flex-direction"].filter((own) =>
        props.has(own),
      );
      if (reflow.length === 0) continue;
      const line = source.slice(0, rule.start).split("\n").length;
      offenders.push(`${line} ${rule.selector.slice(0, 40)} ${reflow.join()}`);
    }

    expect(offenders).toEqual([]);
  });

  it("makes every feature page a query container", () => {
    const source = readStyles("original-shell-overrides.css");
    const rule = scanRules(source).find(
      (candidate) =>
        candidate.selector ===
        ".shell-page-view:not(.assistant-only-view) .page-stack",
    );

    expect(rule?.body).toContain("container-type: inline-size");
  });
});

/*
 * The schedule page set its own clamped page inset and stack gap, which pushed
 * its tab row 90px below the identical row on the catalog pages.
 */
describe("page inset", () => {
  it("insets every feature page the same way", () => {
    const source = readStyles("original-shell-overrides.css");
    const offenders: string[] = [];

    for (const rule of scanRules(source)) {
      // Responsive overrides are expected to differ, so only the unconditional
      // rules have to agree.
      if (rule.atRules.length > 0) continue;
      // Only rules that target one named page; the shared baseline is fine.
      if (!/\[data-shell-view="[\w-]+"\]\s*$/.test(rule.selector)) continue;
      const padding = rule.body.match(/padding:\s*([^;]+)/)?.[1].trim();
      if (padding && padding !== "10px 18px 36px") {
        const line = source.slice(0, rule.start).split("\n").length;
        offenders.push(`${line} ${rule.selector.slice(0, 56)} = ${padding}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("lets no single page set its own stack rhythm", () => {
    // The shared baseline may carry a gap; a page-specific override may not,
    // since that is how the schedule drifted from the rest.
    const source = readStyles("original-shell-overrides.css");
    const offenders: string[] = [];

    for (const rule of scanRules(source)) {
      if (rule.atRules.length > 0) continue;
      if (!/\.page-stack[\w.-]*$/.test(rule.selector)) continue;
      const pageSpecific =
        /\[data-shell-view=/.test(rule.selector) ||
        /\.page-stack\.[\w-]+$/.test(rule.selector);
      if (!pageSpecific) continue;
      const gap = rule.body.match(/(?:^|[\s;])gap:\s*([^;]+)/)?.[1].trim();
      if (gap && gap !== "0") {
        const line = source.slice(0, rule.start).split("\n").length;
        offenders.push(`${line} ${rule.selector.slice(0, 56)} = ${gap}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/*
 * `.screen-shell.command-screen button { color: inherit }` sat at (0,2,1) and so
 * outranked every single- and double-class component rule. Buttons that set their
 * own text colour lost it silently: the selected calendar cell painted dark text
 * on its dark fill, at roughly 1.2:1 contrast.
 */
describe("button colour reset", () => {
  it("does not re-apply colour to all buttons at shell specificity", () => {
    const offenders: string[] = [];

    for (const file of SHELL_FILES) {
      const source = readStyles(file);
      for (const rule of scanRules(source)) {
        // A selector that ends at the bare `button` element but carries two or
        // more classes ahead of it outranks component rules.
        if (!/(^|,)\s*(\.[\w-]+){2,}\s+button\s*$/.test(rule.selector)) continue;
        if (!/(?:^|[\s;])color:/.test(rule.body)) continue;
        const line = source.slice(0, rule.start).split("\n").length;
        offenders.push(`${file}:${line} ${rule.selector.slice(0, 52)}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/*
 * The library and settings routes rendered their Suspense fallback as a bare
 * <p class="library-loading">, and neither class had any CSS at all. A slow
 * chunk load showed one line of 15px body copy at the page's text indent, no
 * spinner and no centring, which read as a broken page rather than a loading
 * one. Fallbacks now share .route-loading-state.
 */
describe("route loading placeholder", () => {
  it("gives every Suspense fallback a styled placeholder", () => {
    const pages = new URL("./", import.meta.url);
    const offenders: string[] = [];

    for (const entry of readdirSync(pages)) {
      if (!entry.endsWith(".tsx") || entry.includes(".test.")) continue;
      const source = readFileSync(new URL(entry, pages).pathname, "utf8");
      if (!source.includes("fallback={")) continue;
      // A fallback whose only content is a <p> has no spinner and no layout.
      for (const match of source.matchAll(
        /fallback=\{([\s\S]*?)\n\s{4,6}\}\s*>/g,
      )) {
        const body = match[1];
        if (!/<p[\s>]/.test(body)) continue;
        if (body.includes("route-loading-state")) continue;
        offenders.push(`${entry} bare <p> fallback`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("styles the placeholder it points at", () => {
    // The old classes were referenced but never defined anywhere.
    const declared = SHELL_FILES.flatMap((file) =>
      rulesOf(file).map((rule) => rule.selector),
    ).join("\n");

    expect(declared).toContain(".route-loading-state");
  });
});

/*
 * The Team page carried a row that named a "workspace" for the whole page. But
 * the workspace already has one source of truth -- the sidebar -- and each
 * office is its own space, so a single page-level workspace was both redundant
 * and wrong. The row (and the native <select> inside it) is gone.
 */
describe("team page workspace scope", () => {
  it("does not restate the workspace the sidebar already shows", () => {
    const source = readComponent("CommandWorkspaceViews.tsx");

    expect(source).not.toContain("team-workspace-scope");
    expect(source).not.toContain("team-workspace-note");
  });

  it("leaves no styles behind for the removed row", () => {
    const declared = SHELL_FILES.map(readStyles).join("\n");

    expect(declared).not.toContain("team-workspace");
  });
});

describe("segmented tabs", () => {
  it("lifts the selected tab above the canvas in both themes", () => {
    // --n-0 is the lightest grey, which sits *below* the dark canvas; the raised
    // surface token is above it in both themes.
    const offenders: string[] = [];

    for (const file of SHELL_FILES) {
      for (const rule of rulesOf(file)) {
        if (!/\.mode-tab\.active$/.test(rule.selector)) continue;
        const background = rule.body.match(/background:\s*([^;]+)/)?.[1].trim();
        if (background && background !== "var(--surface-raised)") {
          offenders.push(`${file} ${rule.selector} = ${background}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("gives the tab strip no track of its own", () => {
    const offenders: string[] = [];

    for (const file of SHELL_FILES) {
      for (const rule of rulesOf(file)) {
        if (!/\.catalog-mode-tabs$/.test(rule.selector)) continue;
        const props = declaredProperties(rule.body);
        if (!props.has("background")) continue;
        const background = rule.body.match(/background:\s*([^;]+)/)?.[1].trim();
        if (background !== "transparent") {
          offenders.push(`${file} ${rule.selector} = ${background}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
