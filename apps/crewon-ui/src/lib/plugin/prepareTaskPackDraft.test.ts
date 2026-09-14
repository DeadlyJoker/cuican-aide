import { describe, expect, it, vi } from "vitest";
import { prepareTaskPackDraft } from "./prepareTaskPackDraft";

describe("preparing a capability draft", () => {
  for (const blocking of [
    { currentDraft: "user work" },
    { hasAttachments: true },
    { isSending: true },
  ])
    it(`preserves existing input for ${Object.keys(blocking)[0]}`, () => {
      const startDraft = vi.fn();
      const setComposerValue = vi.fn();
      const result = prepareTaskPackDraft({
        prompt: "prepared",
        currentDraft: "",
        hasAttachments: false,
        isSending: false,
        locale: "zh",
        startDraft,
        setComposerValue,
        ...blocking,
      });
      expect(result).toContain("避免覆盖");
      expect(startDraft).not.toHaveBeenCalled();
      expect(setComposerValue).not.toHaveBeenCalled();
    });
  it("prepares a fresh composer without any run or permission API", () => {
    const calls: string[] = [];
    expect(
      prepareTaskPackDraft({
        prompt: "prepared",
        currentDraft: "",
        hasAttachments: false,
        isSending: false,
        locale: "en",
        startDraft: () => calls.push("draft"),
        setComposerValue: (value) => calls.push(value),
      }),
    ).toBeNull();
    expect(calls).toEqual(["draft", "prepared"]);
  });
});
