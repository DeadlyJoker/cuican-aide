import { describe, expect, it } from "vitest";

import {
  commandModelEffortLabel,
  commandReasoningEffortOptions,
  reasoningEffortLabel,
  resolveReasoningEffort,
} from "./threadReasoningEffort";
import type { CommandModelOption } from "./threadRuntimeSettings";

const options: CommandModelOption[] = [
  {
    defaultReasoningEffort: "high",
    label: "gpt-5.6-sol",
    reasoningEfforts: [
      { description: "更快", value: "medium" },
      { value: "high" },
      { value: "xhigh" },
    ],
    value: "gpt-5.6-sol",
  },
  {
    label: "gpt-5-legacy",
    value: "gpt-5-legacy",
  },
  {
    label: "gpt-5-mini",
    reasoningEfforts: [{ value: "medium" }],
    value: "gpt-5-mini",
  },
];

describe("reasoningEffortLabel", () => {
  it("localizes known efforts and passes through unknown ones", () => {
    expect(reasoningEffortLabel("xhigh", "zh")).toBe("极高");
    expect(reasoningEffortLabel("xhigh", "en")).toBe("Extra high");
    expect(reasoningEffortLabel("turbo", "zh")).toBe("turbo");
  });
});

describe("commandReasoningEffortOptions", () => {
  it("lists efforts in catalog order with descriptions", () => {
    expect(
      commandReasoningEffortOptions(options, "gpt-5.6-sol", "zh"),
    ).toEqual([
      { detail: "更快", label: "中", value: "medium" },
      { detail: undefined, label: "高", value: "high" },
      { detail: undefined, label: "极高", value: "xhigh" },
    ]);
  });

  it("omits the selector when the model offers no real choice", () => {
    expect(commandReasoningEffortOptions(options, "gpt-5-mini", "zh")).toEqual(
      [],
    );
    expect(commandReasoningEffortOptions(options, "unknown", "zh")).toEqual([]);
  });
});

describe("resolveReasoningEffort", () => {
  it("keeps a supported effort and falls back to the catalog default", () => {
    expect(resolveReasoningEffort(options, "gpt-5.6-sol", "medium")).toBe(
      "medium",
    );
    expect(resolveReasoningEffort(options, "gpt-5.6-sol", "minimal")).toBe(
      "high",
    );
    expect(resolveReasoningEffort(options, "gpt-5-mini", "high")).toBe("medium");
    expect(resolveReasoningEffort(options, "unknown", "high")).toBeNull();
  });
});

describe("commandModelEffortLabel", () => {
  it("joins model and effort into one composer label", () => {
    expect(
      commandModelEffortLabel({
        effort: "xhigh",
        locale: "zh",
        modelLabel: "gpt-5.6-sol",
      }),
    ).toBe("gpt-5.6-sol 极高");
    expect(
      commandModelEffortLabel({
        effort: null,
        locale: "zh",
        modelLabel: "gpt-5.6-sol",
      }),
    ).toBe("gpt-5.6-sol");
  });
});
