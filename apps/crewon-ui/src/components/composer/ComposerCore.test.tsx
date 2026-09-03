import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ComposerCore,
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

  it("keeps the stop control enabled while a turn is running", () => {
    const markup = renderToStaticMarkup(
      <ComposerCore.Form
        className="composer"
        disabled={false}
        running
        stopLabel="停止"
        submitBehavior="enter"
        submitting
        value=""
        onChange={vi.fn()}
        onStop={vi.fn()}
        onSubmit={vi.fn()}
      >
        <ComposerCore.SendButton sendLabel="发送" />
      </ComposerCore.Form>,
    );

    expect(markup).toContain('data-action="stop"');
    expect(markup).toContain('aria-label="停止"');
    expect(markup).not.toContain("disabled");
    expect(markup).toMatchInlineSnapshot(
      `"<form class=\"composer\"><button aria-busy=\"true\" aria-label=\"停止\" class=\"send-button\" data-action=\"stop\" title=\"停止\" type=\"button\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"0\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-square\" aria-hidden=\"true\"><rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"></rect></svg></button></form>"`,
    );
  });
});
