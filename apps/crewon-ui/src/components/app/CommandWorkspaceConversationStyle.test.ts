// @ts-expect-error Vitest runs this snapshot in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("command workspace conversation style", () => {
  it("snapshots the lightweight home, sidebar, composer, and failure surfaces", () => {
    const styles = readFileSync(
      new URL("../../styles/command-lightweight.css", import.meta.url),
      "utf8",
    );
    expect(styles).toMatchSnapshot();
  });

  it("snapshots the centered transcript loading indicator", () => {
    const appStyles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const start = appStyles.indexOf(".message-loading-state {");
    const end = appStyles.indexOf(".message-icon {", start);

    expect([start, end]).not.toContain(-1);
    expect(appStyles.slice(start, end).trim()).toMatchSnapshot();
  });

  it("snapshots the compact Codex-inspired transcript contract", () => {
    const conversationStyles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Keep active conversations close to Codex's quiet transcript hierarchy. */";
    const endMarker =
      "/* Sidebar task signals keep full titles discoverable without widening the rail. */";
    const contract = conversationStyles
      .slice(
        conversationStyles.indexOf(marker),
        conversationStyles.indexOf(endMarker),
      )
      .trim();

    expect(contract).toMatchSnapshot();
  });

  it("reserves a separate trailing slot for the tool disclosure icon", () => {
    const appStyles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const conversationStyles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const disclosureStart = appStyles.indexOf(
      ".compact-tool-card summary::after,",
    );
    const disclosureEnd = appStyles.indexOf("}", disclosureStart) + 1;
    const commandHeaderStart = conversationStyles.indexOf(
      ".screen-shell.command-screen\n  .command-thread-room\n  .turn-process-items\n  .tool-card-header {",
    );
    const commandHeaderEnd =
      conversationStyles.indexOf("}", commandHeaderStart) + 1;

    expect([disclosureStart, commandHeaderStart]).not.toContain(-1);
    expect(appStyles.slice(disclosureStart, disclosureEnd)).toContain(
      "right: 10px",
    );
    expect(
      conversationStyles.slice(commandHeaderStart, commandHeaderEnd),
    ).toContain("padding: 0 26px 0 0");
  });

  it("aligns the tool approval bar with the composer above the input", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const start = styles.indexOf(
      ".screen-shell.command-screen .composer-tool-approval {",
    );
    const end = styles.indexOf("}", start) + 1;

    expect(start).toBeGreaterThan(-1);
    expect(styles.slice(start, end)).toContain("width: min(720px, 100%)");
    expect(styles.slice(start, end)).toContain(
      "grid-template-columns: minmax(0, 1fr) auto",
    );
  });

  it("keeps the portaled Run Plan checklist usable at low and narrow viewports", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const popoverStart = styles.indexOf(".composer-progress-popover {");
    const headerStart = styles.indexOf(
      ".composer-progress-popover-header {",
      popoverStart,
    );
    const checklistStart = styles.indexOf(
      ".composer-progress-checklist {",
      headerStart,
    );
    const checklistEnd = styles.indexOf(
      ".composer-progress-checklist > li {",
      checklistStart,
    );
    const focusStart = styles.indexOf(
      ".screen-shell.command-screen button.composer-progress-pill:focus-visible {",
    );
    const focusEnd = styles.indexOf("}", focusStart) + 1;
    const narrowStart = styles.indexOf(
      "@media (max-width: 420px)",
      checklistEnd,
    );
    const narrowEnd = styles.indexOf("\n\n/*", narrowStart);

    expect([
      popoverStart,
      headerStart,
      checklistStart,
      checklistEnd,
      focusStart,
      narrowStart,
      narrowEnd,
    ]).not.toContain(-1);
    expect(styles.slice(popoverStart, headerStart)).toContain(
      "width: min(360px, calc(100vw - 24px))",
    );
    expect(styles.slice(popoverStart, headerStart)).toContain(
      "max-height: min(420px, var(--radix-popover-content-available-height))",
    );
    expect(styles.slice(popoverStart, headerStart)).toContain(
      "overflow: hidden",
    );
    expect(styles.slice(checklistStart, checklistEnd)).toContain(
      "var(--radix-popover-content-available-height)",
    );
    expect(styles.slice(checklistStart, checklistEnd)).toContain(
      "overflow-y: auto",
    );
    expect(styles.slice(focusStart, focusEnd)).toContain(
      "outline: 2px solid var(--accent)",
    );
    expect(styles.slice(narrowStart, narrowEnd)).toContain(
      "width: calc(100vw - 16px)",
    );
  });

  it("keeps Run Plan progress as flat metadata instead of a floating capsule", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const pillStart = styles.indexOf(
      ".screen-shell.command-screen .composer-progress-pill {",
    );
    const buttonStart = styles.indexOf(
      ".screen-shell.command-screen button.composer-progress-pill {",
      pillStart,
    );
    const hoverStart = styles.indexOf(
      ".screen-shell.command-screen button.composer-progress-pill:hover,",
      buttonStart,
    );

    expect([pillStart, buttonStart, hoverStart]).not.toContain(-1);
    const pillContract = styles.slice(pillStart, buttonStart);
    expect(pillContract).toContain("border: 0");
    expect(pillContract).toContain("background: transparent");
    expect(pillContract).toContain("border-radius: var(--radius-sm)");
    expect(pillContract).not.toContain("var(--radius-pill)");
    const buttonContract = styles.slice(buttonStart, hoverStart);
    expect(buttonContract).toContain("box-shadow: none");
    expect(buttonContract).not.toContain("font: inherit");
  });

  it("snapshots the assistant and home conversation alignment contract", () => {
    const conversationStyles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Assistant uses the same real thread transcript and composer as the home chat. */";
    const endMarker =
      "/* Three-scene command home: Scene controls the task contract; execution target is independent. */";
    const contract = conversationStyles
      .slice(
        conversationStyles.indexOf(marker),
        conversationStyles.indexOf(endMarker),
      )
      .trim();

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the markdown table sizing contract", () => {
    const appStyles = readFileSync(
      new URL("../../styles/app.css", import.meta.url),
      "utf8",
    );
    const marker = ".markdown-content table {";
    const baseContract = appStyles
      .slice(
        appStyles.indexOf(marker),
        appStyles.indexOf(".markdown-content th,"),
      )
      .trim();
    const commandMarker = `.message[data-kind="agentMessage"]
  .markdown-content
  table {`;
    const commandStart = appStyles.indexOf(commandMarker);
    const commandEnd = appStyles.indexOf("\n}", commandStart) + 2;
    const commandContract = appStyles.slice(commandStart, commandEnd).trim();

    expect({ baseContract, commandContract }).toMatchSnapshot();
  });

  it("snapshots resource tags and the command file picker contract", () => {
    const conversationStyles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Resource attachments stay compact in the composer, while Skill and MCP remain visible in the sent message. */";
    const endMarker =
      "/* Keep active conversations close to Codex's quiet transcript hierarchy. */";
    const contract = conversationStyles
      .slice(
        conversationStyles.indexOf(marker),
        conversationStyles.indexOf(endMarker),
      )
      .trim();

    expect(contract).toMatchSnapshot();
  });

  it("snapshots the compact add-resource palette contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const marker =
      "/* Keep the add-resource palette dense enough to compare names and descriptions at a glance. */";
    const start = styles.indexOf(marker);
    const end = styles.indexOf(".slash-palette[hidden]", start);

    expect(styles.slice(start, end).trim()).toMatchSnapshot();
  });

  it("snapshots the resizable workbench right-pane contract", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const routeStart = styles.indexOf(".command-shell-route {");
    const routeEnd = styles.indexOf(
      ".command-shell-route > .screen-shell.command-screen {",
      routeStart,
    );
    const workbenchComment = styles.indexOf(
      "/* Codex-parity tool workbench: real browser, terminal, file and review surfaces. */",
    );
    const workbenchStart = styles.indexOf(
      ".command-workbench {",
      workbenchComment,
    );
    const workbenchEnd = styles.indexOf(
      ".command-workbench[hidden]",
      workbenchStart,
    );
    const handleStart = styles.indexOf(".command-workbench-resize-handle {");
    const handleEnd = styles.indexOf(
      ".command-workbench-tabbar {",
      handleStart,
    );
    const responsiveStart = styles.lastIndexOf("@media (max-width: 1379px)");
    const responsiveEnd = styles.indexOf(
      "@media (max-width: 760px)",
      responsiveStart,
    );

    expect([
      routeStart,
      routeEnd,
      workbenchComment,
      workbenchStart,
      workbenchEnd,
      handleStart,
      handleEnd,
      responsiveStart,
      responsiveEnd,
    ]).not.toContain(-1);

    const contract = [
      styles.slice(routeStart, routeEnd),
      styles.slice(workbenchStart, workbenchEnd),
      styles.slice(handleStart, handleEnd),
      styles.slice(responsiveStart, responsiveEnd),
    ]
      .join("\n")
      .trim();

    expect(contract).not.toContain("position: fixed");
    expect(contract).toMatchSnapshot();
  });

  /*
   * A page iframe is its own event target, so without this rule it claimed the
   * pointer as soon as a width drag crossed the handle and the resize froze
   * halfway. Pointer capture on the handle is the primary fix; this rule is the
   * guard that no engine quirk can steal the drag back.
   */
  it("makes the browser page inert while the workbench is being resized", () => {
    const styles = readFileSync(
      new URL("../../styles/original-shell-overrides.css", import.meta.url),
      "utf8",
    );
    const ruleStart = styles.indexOf(
      '.command-workbench[data-resizing="true"] .command-browser-viewport iframe',
    );
    expect(ruleStart).not.toBe(-1);
    expect(styles.slice(ruleStart, styles.indexOf("}", ruleStart))).toContain(
      "pointer-events: none",
    );
  });
});
