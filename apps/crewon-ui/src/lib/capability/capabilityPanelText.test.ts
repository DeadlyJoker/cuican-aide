import { describe, expect, it } from "vitest";

import { defaultCapabilityPanel } from "./capabilityPanelText";

describe("capability panel text helpers", () => {
  it("builds default capability panel", () => {
    expect(defaultCapabilityPanel("zh")).toEqual({
      title: "能力",
    });
  });
});
