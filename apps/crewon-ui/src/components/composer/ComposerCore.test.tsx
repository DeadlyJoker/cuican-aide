import { describe, expect, it, vi } from "vitest";

import {
  composerSubmitBlocked,
  composerKeyIntent,
  createComposerSubmitGuard,
} from "./ComposerCore";

const baseKey = {
  altKey: false,
  composerValue: "继续推进",
  ctrlKey: false,
  hasOpenPalette: false,
  isComposing: false,
  key: "Enter",
  metaKey: false,
  shiftKey: false,
  submitBehavior: "enter" as const,
};

describe("ComposerCore", () => {
  it("blocks every submit path while a palette is open", () => {
    expect(
      composerSubmitBlocked({
        disabled: false,
        paletteOpen: true,
        submitting: false,
      }),
    ).toBe(true);
    expect(
      composerSubmitBlocked({
        disabled: false,
        paletteOpen: false,
        submitBlocked: true,
        submitting: false,
      }),
    ).toBe(true);
  });

  it("maps IME, submit, newline, modifier, and palette keyboard intents", () => {
    expect(composerKeyIntent(baseKey)).toBe("send");
    expect(composerKeyIntent({ ...baseKey, shiftKey: true })).toBeNull();
    expect(composerKeyIntent({ ...baseKey, isComposing: true })).toBeNull();
    expect(
      composerKeyIntent({
        ...baseKey,
        submitBehavior: "modifierEnter",
      }),
    ).toBeNull();
    expect(
      composerKeyIntent({
        ...baseKey,
        ctrlKey: true,
        submitBehavior: "modifierEnter",
      }),
    ).toBe("send");
    expect(
      composerKeyIntent({ ...baseKey, hasOpenPalette: true }),
    ).toBeNull();
    expect(
      composerKeyIntent({
        ...baseKey,
        hasOpenPalette: true,
        key: "Escape",
      }),
    ).toBe("closePalette");
    expect(composerKeyIntent({ ...baseKey, key: "@" })).toBe("openContext");
    expect(
      composerKeyIntent({ ...baseKey, composerValue: "调用 ", key: "/" }),
    ).toBe("openSlash");
    expect(
      composerKeyIntent({
        ...baseKey,
        composerValue: "https://example.com/",
        key: "/",
      }),
    ).toBeNull();
  });

  it("prevents concurrent submits and leaves draft ownership to the caller", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onSubmit = vi.fn(() => pending);
    const submit = createComposerSubmitGuard();
    const value = "  保留草稿  ";
    await expect(submit(value, true, onSubmit)).resolves.toBe(false);
    const first = submit(value, false, onSubmit);
    await expect(submit(value, false, onSubmit)).resolves.toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("保留草稿");
    expect(value).toBe("  保留草稿  ");
    release?.();
    await expect(first).resolves.toBe(true);
  });
});
