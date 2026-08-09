// @ts-expect-error Vitest runs this check in Node, while the browser bundle omits Node types.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * The window controls had drifted into three implementations: the title bar
 * rendered a platform-aware clickable group, while the command sidebar and the
 * settings sidebar each hardcoded three decorative <span class="dot"> lights.
 * The settings copy took no platform at all, so Windows also got macOS traffic
 * lights, and neither copy responded to a click. These checks keep the three
 * shells on the one component.
 */
function componentSources(): { name: string; source: string }[] {
  const found: { name: string; source: string }[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir));
      } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
        found.push({
          name: entry.name,
          source: readFileSync(new URL(entry.name, dir).pathname, "utf8"),
        });
      }
    }
  };
  walk(new URL("./", import.meta.url));
  return found;
}

describe("window controls", () => {
  it("leaves no shell hand-rolling its own traffic lights", () => {
    const offenders = componentSources()
      .filter(({ source }) => /className="dot (close|min|max)"/.test(source))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it("gives every mount point the platform it must render for", () => {
    // A control group without a platform is the settings-page bug: macOS lights
    // painted on Windows.
    const offenders = componentSources()
      .filter(({ source }) => source.includes("<TitleBarWindowControls"))
      .filter(({ source }) =>
        source
          .split("<TitleBarWindowControls")
          .slice(1)
          .some((mount) => !mount.slice(0, 240).includes("platform=")),
      )
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  /*
   * Per-screen mounting is what left the login gate and the connecting spinner
   * with a frameless, undraggable window: they simply never rendered a control
   * group. One frame above the router cannot be forgotten by a new screen.
   */
  it("mounts the controls in exactly one place", () => {
    const mounts = componentSources()
      .filter(({ source }) => source.includes("<TitleBarWindowControls"))
      .map(({ name }) => name)
      .sort();

    expect(mounts).toEqual(["DesktopWindowFrame.tsx", "TitleBar.tsx"]);
  });

  it("wraps the router in the frame rather than each route", () => {
    const entry = readFileSync(
      new URL("../main.tsx", import.meta.url),
      "utf8",
    );

    // The frame must sit outside the auth gate, or the login screen loses it.
    const frameAt = entry.indexOf("<DesktopWindowFrame>");
    const gateAt = entry.indexOf("<AgentPlatformAuthGate>");
    expect(frameAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(frameAt);
  });

  /*
   * Two different questions that both used to be `isTauri()`. Drawing the chrome
   * keys off the surface, so `?surface=desktop` can render it in a browser;
   * calling into the host keys off the bridge, because a faked surface has no IPC
   * and the call fails inside the plugin instead of falling back.
   */
  it("draws the chrome by surface but calls the host by bridge", () => {
    const controls = readFileSync(
      new URL("./TitleBarWindowControls.tsx", import.meta.url),
      "utf8",
    );

    expect(controls).toContain('detectRuntimeSurface() === "desktop"');
    expect(controls).toContain("hasDesktopBridge()");
    // Comments still name it, so only an actual import counts as a use.
    expect(controls).not.toMatch(/^import .*\bisTauri\b/m);
  });

  it("gives the frameless window a drag surface", () => {
    const frame = readFileSync(
      new URL("./DesktopWindowFrame.tsx", import.meta.url),
      "utf8",
    );

    // Without a drag region an undecorated window cannot be moved at all.
    expect(frame).toContain("data-tauri-drag-region");
  });

  it("styles the lights in one place", () => {
    const styles = readFileSync(
      new URL("../styles/app.css", import.meta.url),
      "utf8",
    );

    // The old per-screen copies each defined their own hue and size.
    expect(styles).not.toContain(".settings-traffic .dot");
    expect(styles).not.toContain(".screen-shell.command-screen .dot");
    // The glyph is what makes a light read as a button on hover.
    expect(styles).toContain(".traffic-light-glyph");
  });
});
