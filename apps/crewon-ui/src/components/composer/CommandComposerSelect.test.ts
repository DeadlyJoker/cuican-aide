import { describe, expect, it } from "vitest";

import { commandComposerSelectValue } from "./CommandComposer";

describe("commandComposerSelectValue", () => {
  const options = [
    { label: "No workspace", value: "__no_workspace__" },
    { label: "Project", value: "/repo/project" },
  ];

  it("accepts values that belong to the rendered option set", () => {
    expect(commandComposerSelectValue(options, "/repo/project")).toBe(
      "/repo/project",
    );
  });

  it("ignores Radix transient empty value notifications", () => {
    expect(commandComposerSelectValue(options, "")).toBeNull();
  });
});
