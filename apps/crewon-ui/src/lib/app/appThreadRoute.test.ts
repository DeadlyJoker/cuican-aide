import { describe, expect, it } from "vitest";
import { threadSelectionFromSearch } from "./appThreadRoute";

describe("threadSelectionFromSearch", () => {
  it("prefers the displayed scene thread to a stale execution binding", () => {
    expect(
      threadSelectionFromSearch(
        "?sceneThread=thread-b&executionTargetThread=thread-a",
      ),
    ).toBe("thread-b");
  });
  it("accepts an execution-only legacy link", () => {
    expect(threadSelectionFromSearch("?executionTargetThread=thread-b")).toBe(
      "thread-b",
    );
  });
  it.each([
    "",
    "?sceneThread=",
    "?sceneThread=%20thread-b",
    "?sceneThread=thread%00b",
    "?sceneThread=thread%7Fb",
    "?sceneThread=thread-a&sceneThread=thread-b",
    "?sceneThread=&executionTargetThread=thread-b",
    `?sceneThread=${"x".repeat(513)}`,
  ])(
    "retains the original fallback for absent or malformed navigation (%s)",
    (search) => {
      expect(threadSelectionFromSearch(search)).toBeNull();
    },
  );
});
