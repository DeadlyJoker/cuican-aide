import { describe, expect, it } from "vitest";

import {
  appViewFromSearch,
  isCommandShellHash,
  libraryViewFromSearch,
  shouldRenderCommandShellView,
  settingsSectionFromSearch,
} from "./appRouting";

describe("app routing search parsing", () => {
  it("routes settings view directly", () => {
    expect(appViewFromSearch("?view=settings")).toBe("settings");
  });

  it("routes library views through the library shell", () => {
    expect(appViewFromSearch("?view=tools")).toBe("library");
    expect(appViewFromSearch("view=agents")).toBe("library");
    expect(appViewFromSearch("?view=automation")).toBe("library");
    expect(appViewFromSearch("?view=knowledge")).toBe("library");
  });

  it("falls back to chat for missing or unknown views", () => {
    expect(appViewFromSearch("")).toBe("chat");
    expect(appViewFromSearch("?view=office")).toBe("chat");
    expect(appViewFromSearch("?view=unknown")).toBe("chat");
  });

  it("returns the concrete library kind when supported", () => {
    expect(libraryViewFromSearch("?view=plugins")).toBe("plugins");
    expect(libraryViewFromSearch("?view=office")).toBeNull();
    expect(libraryViewFromSearch("?view=settings")).toBeNull();
  });

  it("parses settings sections with general settings fallback", () => {
    expect(settingsSectionFromSearch("?section=appearance")).toBe("appearance");
    expect(settingsSectionFromSearch("section=mcp-servers")).toBe("mcp-servers");
    expect(settingsSectionFromSearch("?section=unknown")).toBe("appearance");
    expect(settingsSectionFromSearch("")).toBe("appearance");
  });

  it("detects command shell hash routes independently from selected threads", () => {
    expect(isCommandShellHash("#view-command")).toBe(true);
    expect(isCommandShellHash("#view-agents")).toBe(true);
    expect(isCommandShellHash("#view-settings")).toBe(false);
    expect(isCommandShellHash("")).toBe(false);
  });

  it("lets top-level settings and library views replace the command shell", () => {
    expect({
      chat: shouldRenderCommandShellView("chat"),
      library: shouldRenderCommandShellView("library"),
      settings: shouldRenderCommandShellView("settings"),
    }).toMatchInlineSnapshot(`
      {
        "chat": true,
        "library": false,
        "settings": false,
      }
    `);
  });
});
