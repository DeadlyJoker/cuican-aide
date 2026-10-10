import { describe, expect, it } from "vitest";
import {
  commandNavigationNextIndex,
  commandSearchShortcutRequested,
} from "./commandNavigationKeyboard";

describe("command navigation keyboard behavior", () => {
  it.each([
    ["ArrowUp", 0, 5, 4],
    ["ArrowDown", 4, 5, 0],
    ["ArrowDown", -1, 5, 0],
    ["ArrowUp", -1, 5, 4],
    ["Home", 3, 5, 0],
    ["End", 1, 5, 4],
    ["ArrowDown", 0, 0, null],
    ["Enter", 1, 5, null],
    ["Escape", 0, 5, null],
  ])(
    "%s moves focus from %i in a list of %i items",
    (key, index, count, expected) => {
      expect(
        commandNavigationNextIndex(
          key as string,
          index as number,
          count as number,
        ),
      ).toBe(expected);
    },
  );
  const key = {
    key: "k",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
  };
  it("accepts both operating systems' search shortcuts", () => {
    expect(commandSearchShortcutRequested(key)).toBe(true);
    expect(
      commandSearchShortcutRequested({
        ...key,
        key: "K",
        metaKey: false,
        ctrlKey: true,
      }),
    ).toBe(true);
  });
  it.each([
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { defaultPrevented: true },
    { altKey: true },
    { shiftKey: true },
    { key: "Escape" },
    { metaKey: false },
  ])(
    "leaves composition, repeats and unrelated shortcuts alone: %o",
    (override) => {
      expect(commandSearchShortcutRequested({ ...key, ...override })).toBe(
        false,
      );
    },
  );
});
