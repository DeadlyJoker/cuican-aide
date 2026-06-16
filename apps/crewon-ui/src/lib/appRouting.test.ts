import { describe, expect, it } from "vitest";

import {
  appViewFromSearch,
  libraryViewFromSearch,
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
});
