import { describe, expect, it } from "vitest";
import { normalizePluginUiViteImportPath } from "./pluginUiViteImportPath";

const mount = "a".repeat(32);
const assets = `/api/v1/plugins/ui/mounts/${mount}/assets/`;

describe("installed UI Vite native import transport", () => {
  it.each([
    "ui.mjs",
    "ui.js",
    "chunks/view.js",
    "chunks/nested/view.mjs",
    "%E7%9F%AD%E5%89%A7.js",
  ])(
    "normalizes the exact empty dev marker for a declared JS path: %s",
    (file) => {
      expect(normalizePluginUiViteImportPath(`${assets}${file}?import`)).toBe(
        `${assets}${file}`,
      );
    },
  );
  it.each([
    "",
    "?import=",
    "?import=value",
    "?other",
    "?import&extra",
    "?other&import",
    "?import#fragment",
    "?import?other",
    "?%69mport",
  ])(
    "preserves ordinary or nonexact queries for the strict HTTP route: %s",
    (query) => {
      const path = `${assets}ui.mjs${query}`;
      expect(normalizePluginUiViteImportPath(path)).toBe(path);
    },
  );
  it.each([
    "picture.png",
    "theme.css",
    "manifest.json",
    "page.html",
    "node.cjs",
    "ui.JS",
    "LICENSE",
  ])("does not strip markers from non-JS assets: %s", (file) => {
    const path = `${assets}${file}?import`;
    expect(normalizePluginUiViteImportPath(path)).toBe(path);
  });
  it.each([
    "/api/v1/plugins/ui/catalog?import",
    `/api/v1/plugins/ui/mounts/${mount}?import`,
    `/api/v1/plugins/ui/mounts/${mount}/actions?import`,
    `/api/v1/plugins/packages/${mount}/assets/ui.js?import`,
    `/api/v1/other/${mount}/assets/ui.js?import`,
    `/api/v1/plugins/ui/mounts/${"a".repeat(31)}/assets/ui.js?import`,
    `/api/v1/plugins/ui/mounts/${"a".repeat(129)}/assets/ui.js?import`,
    `/api/v1/plugins/ui/mounts/${"!".repeat(32)}/assets/ui.js?import`,
    `https://crewon.example${assets}ui.js?import`,
  ])("leaves other routes and invalid references unchanged: %s", (path) => {
    expect(normalizePluginUiViteImportPath(path)).toBe(path);
  });
  it.each([
    "../ui.js",
    "%2e%2e/ui.js",
    "./ui.js",
    "chunks//ui.js",
    "/ui.js",
    "chunks%2fui.js",
    "chunks%5cui.js",
    "chunks/%2541.js",
    "@private/ui.js",
    "%40private/ui.js",
    "a%3Ab.js",
    "a%3Fb.js",
    "a%23b.js",
    "%00ui.js",
    "a%20b.js",
    "a%E2%80%8Bb.js",
    "%ED%A0%80.js",
    "%FF.js",
    "a\\b.js",
    "a\ud800.js",
  ])("does not normalize invalid logical paths: %s", (file) => {
    const path = `${assets}${file}?import`;
    expect(normalizePluginUiViteImportPath(path)).toBe(path);
  });
  it("keeps the existing 256-byte logical-path bound before dropping a marker", () => {
    const boundary = "a".repeat(253) + ".js";
    expect(normalizePluginUiViteImportPath(`${assets}${boundary}?import`)).toBe(
      `${assets}${boundary}`,
    );
    const excess = `${assets}${"a".repeat(254)}.js?import`;
    expect(normalizePluginUiViteImportPath(excess)).toBe(excess);
    const unicodeExcess = `${assets}${encodeURIComponent("剧".repeat(85))}.js?import`;
    expect(normalizePluginUiViteImportPath(unicodeExcess)).toBe(unicodeExcess);
    const huge = `${assets}${"a".repeat(2048)}.js?import`;
    expect(normalizePluginUiViteImportPath(huge)).toBe(huge);
  });
});
