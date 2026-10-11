// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readThreadModelSelection,
  writeThreadModelSelection,
} from "./threadModelSelection";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("conversation model preferences", () => {
  it("keeps independently saved choices for different conversations", () => {
    writeThreadModelSelection("thread-a", "gpt-6.1-sol");
    writeThreadModelSelection("thread-b", "gpt-6-astra");
    expect(readThreadModelSelection("thread-a")?.modelId).toBe("gpt-6.1-sol");
    expect(readThreadModelSelection("thread-b")?.modelId).toBe("gpt-6-astra");
  });

  it("does not overwrite a newer manual choice when a prior submission returns", () => {
    writeThreadModelSelection("thread-b", "gpt-6.1-sol");
    const initial = readThreadModelSelection("thread-b")!.selectionId;
    writeThreadModelSelection("thread-b", "gpt-6-astra");
    expect(
      writeThreadModelSelection("thread-b", "gpt-6.1-sol", {
        expectedSelectionId: initial,
      }),
    ).toBe(false);
    expect(readThreadModelSelection("thread-b")?.modelId).toBe("gpt-6-astra");
  });

  it("bounds saved conversations and preserves unrelated app storage", () => {
    window.localStorage.setItem("unrelated-setting", "keep");
    for (let index = 0; index < 150; index++) {
      vi.spyOn(Date, "now").mockReturnValue(index);
      writeThreadModelSelection(`thread-${index}`, "gpt-6.1-sol");
    }
    expect(window.localStorage.length).toBe(129);
    expect(readThreadModelSelection("thread-0")).toBeNull();
    expect(readThreadModelSelection("thread-149")?.modelId).toBe("gpt-6.1-sol");
    expect(window.localStorage.getItem("unrelated-setting")).toBe("keep");
  });

  it("rejects unsafe identifiers and treats storage failure as an optional preference", () => {
    expect(writeThreadModelSelection("thread-a", "bad\nmodel")).toBe(false);
    expect(writeThreadModelSelection("bad\ud800thread", "gpt-6.1-sol")).toBe(
      false,
    );
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(writeThreadModelSelection("thread-a", "gpt-6.1-sol")).toBe(false);
    expect(readThreadModelSelection("thread-a")).toBeNull();
  });
});
