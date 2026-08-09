import { describe, expect, it } from "vitest";

import {
  CREWON_OFFICIAL_VENDOR_ID,
  CUSTOM_VENDOR_ID,
  MODEL_PROVIDER_VENDORS,
  modelProviderVendor,
  vendorForBaseUrl,
  vendorNote,
} from "./modelProviderVendors";

describe("modelProviderVendors", () => {
  it("offers the Crewon account first so the no-key path is the default", () => {
    expect(MODEL_PROVIDER_VENDORS[0].id).toBe(CREWON_OFFICIAL_VENDOR_ID);
    expect(MODEL_PROVIDER_VENDORS[0].credentialStyle).toBe("crewon-account");
  });

  it("keeps the custom escape hatch last", () => {
    expect(MODEL_PROVIDER_VENDORS.at(-1)?.id).toBe(CUSTOM_VENDOR_ID);
  });

  it("leaves the custom vendor without a base URL so the user supplies one", () => {
    expect(modelProviderVendor(CUSTOM_VENDOR_ID)?.baseUrl).toBeUndefined();
  });

  it("gives every keyed vendor a base URL and an env var", () => {
    // A vendor needing a key is only useful if we know where to send it.
    for (const vendor of MODEL_PROVIDER_VENDORS) {
      if (vendor.credentialStyle !== "api-key") continue;
      if (vendor.id === CUSTOM_VENDOR_ID) continue;
      expect(vendor.baseUrl, `${vendor.id} base URL`).toBeTruthy();
      expect(vendor.envKey, `${vendor.id} env key`).toBeTruthy();
    }
  });

  it("recovers the vendor from a configured base URL", () => {
    expect(vendorForBaseUrl("https://api.moonshot.cn/v1")?.id).toBe("moonshot");
  });

  it("ignores a trailing slash when matching", () => {
    expect(vendorForBaseUrl("https://api.moonshot.cn/v1/")?.id).toBe(
      "moonshot",
    );
  });

  it("treats an unknown address as custom, not a vendor", () => {
    expect(vendorForBaseUrl("https://gateway.internal/v1")).toBeNull();
    expect(vendorForBaseUrl("")).toBeNull();
  });

  it("uses unique ids so a pick resolves to one vendor", () => {
    const ids = MODEL_PROVIDER_VENDORS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("localizes the note", () => {
    const vendor = modelProviderVendor("moonshot");
    expect(vendor).not.toBeNull();
    if (vendor === null) return;
    expect(vendorNote(vendor, "zh")).toBe(vendor.note.zh);
    expect(vendorNote(vendor, "en")).toBe(vendor.note.en);
  });
});
