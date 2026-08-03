import { describe, expect, it } from "vitest";

import { segmentedKeyTarget } from "./segmentedKeyboard";

describe("segmentedKeyTarget", () => {
  it("moves forward and backward with either axis of arrow keys", () => {
    const from = (key: string) =>
      segmentedKeyTarget({ count: 3, key, selectedIndex: 1 });

    expect([
      from("ArrowRight"),
      from("ArrowDown"),
      from("ArrowLeft"),
      from("ArrowUp"),
    ]).toEqual([2, 2, 0, 0]);
  });

  it("wraps at both ends so neither is a dead stop", () => {
    expect([
      segmentedKeyTarget({ count: 3, key: "ArrowRight", selectedIndex: 2 }),
      segmentedKeyTarget({ count: 3, key: "ArrowLeft", selectedIndex: 0 }),
    ]).toEqual([0, 2]);
  });

  it("ignores keys that are not navigation keys", () => {
    expect([
      segmentedKeyTarget({ count: 3, key: "Enter", selectedIndex: 0 }),
      segmentedKeyTarget({ count: 3, key: "a", selectedIndex: 0 }),
      segmentedKeyTarget({ count: 3, key: "Tab", selectedIndex: 0 }),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it("has no target when there are no segments", () => {
    expect(
      segmentedKeyTarget({ count: 0, key: "ArrowRight", selectedIndex: 0 }),
    ).toBeUndefined();
  });
});
