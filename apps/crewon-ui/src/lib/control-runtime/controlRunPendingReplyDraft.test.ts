import { describe, expect, it } from "vitest";
import { ControlRunPendingReplyDrafts } from "./controlRunPendingReplyDraft";

describe("bounded Run-local reply previews", () => {
  it("keeps each Run independent and replaces retry-discarded output", () => {
    const drafts = new ControlRunPendingReplyDrafts();
    drafts.apply("old", { reset: false, delta: "上一轮" });
    drafts.apply("new", { reset: true, delta: "新回复" });
    expect(drafts.get("old")?.text).toBe("上一轮");
    drafts.apply("new", { reset: true, delta: "" });
    expect(drafts.get("new")).toBeNull();
    drafts.apply("new", { reset: false, delta: "恢复输出" });
    expect(drafts.get("new")).toEqual({
      localId: "pending-reply:new",
      text: "恢复输出",
      partial: false,
    });
    drafts.delete("old");
    expect(drafts.get("old")).toBeNull();
    drafts.clear();
    expect(drafts.get("new")).toBeNull();
  });

  it("bounds retained text and does not split a Unicode surrogate pair", () => {
    const drafts = new ControlRunPendingReplyDrafts();
    drafts.apply("run", {
      reset: false,
      delta: "a" + "😀".repeat(65536) + "z",
    });
    const preview = drafts.get("run")!;
    expect(preview.text.length).toBeLessThanOrEqual(128 * 1024);
    expect(preview.text.charCodeAt(0)).not.toBe(0xde00);
    expect(preview.partial).toBe(true);
  });

  it("evicts old Run previews instead of retaining unbounded failed network payloads", () => {
    const drafts = new ControlRunPendingReplyDrafts();
    for (let index = 0; index < 33; index++)
      drafts.apply(String(index), { reset: false, delta: "text" });
    expect(drafts.get("0")).toBeNull();
    expect(drafts.get("1")?.text).toBe("text");
    expect(drafts.get("32")?.text).toBe("text");
  });
});
