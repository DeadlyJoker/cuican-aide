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
    expect(appViewFromSearch("?view=unknown")).toBe("chat");
  });

  it("returns the concrete library kind when supported", () => {
    expect(libraryViewFromSearch("?view=plugins")).toBe("plugins");
    expect(libraryViewFromSearch("?view=office")).toBe("office");
    expect(libraryViewFromSearch("?view=settings")).toBeNull();
  });

  it("parses settings sections with account fallback", () => {
    expect(settingsSectionFromSearch("?section=appearance")).toBe("appearance");
    expect(settingsSectionFromSearch("section=mcp-servers")).toBe("mcp-servers");
    expect(settingsSectionFromSearch("?section=unknown")).toBe("account");
    expect(settingsSectionFromSearch("")).toBe("account");
  });

  it("detects command shell hash routes independently from selected threads", () => {
    expect(isCommandShellHash("#view-command")).toBe(true);
    expect(isCommandShellHash("#view-agents")).toBe(true);
    expect(isCommandShellHash("#view-settings")).toBe(false);
    expect(isCommandShellHash("")).toBe(false);
  });

  it("uses the command shell for the default chat app view", () => {
    expect(shouldRenderCommandShellView("chat")).toBe(true);
    expect(shouldRenderCommandShellView("settings", true)).toBe(true);
    expect(shouldRenderCommandShellView("library", true)).toBe(true);
    expect(shouldRenderCommandShellView("settings")).toBe(false);
    expect(shouldRenderCommandShellView("library")).toBe(false);
  });
});
