import { describe, expect, it } from "vitest";
import { createDemoTurn, createDraftDemoThread } from "../demo/demoData";
import {
  controlThreadHasPendingCanonicalSync,
  presentControlRunTerminal,
  preserveControlRunSynchronizations,
  clearControlRunSynchronization,
  controlPendingReplyDraft,
  updateControlPendingReplyDraft,
} from "./controlRunTerminalPresentation";
import { controlRunTerminal } from "./controlRunSettlement";

function thread() {
  const value = createDraftDemoThread({
    locale: "zh",
    newDraftPreview: "",
    newDraftThread: "终态同步",
  });
  value.turns = [
    createDemoTurn({ text: "写一个故事", responseText: "" }),
    createDemoTurn({ text: "再写一集", responseText: "" }),
  ];
  value.turns[0]!.id = "first";
  value.turns[1]!.id = "second";
  value.turns.forEach((turn) => {
    turn.status = "inProgress";
  });
  value.status = { type: "active", activeFlags: [] };
  return value;
}

const terminal = {
  status: "completed",
  lastSequence: 4,
  terminalAt: "2026-10-10T00:00:03Z",
} as const;

describe("trusted terminal presentation", () => {
  it("updates only the matching Run and preserves genuine user items and identifiers", () => {
    const before = thread();
    const result = presentControlRunTerminal(before, "first", terminal);
    expect(result.turns[0]!.status).toBe("completed");
    expect(result.turns[0]!.items).toBe(before.turns[0]!.items);
    expect(result.turns[1]).toBe(before.turns[1]);
    expect(result.status.type).toBe("active");
    expect(controlThreadHasPendingCanonicalSync(result)).toBe(true);
    const outsideWindow = presentControlRunTerminal(
      before,
      "unrelated",
      terminal,
    );
    expect(outsideWindow.turns).toEqual(before.turns);
    expect(controlThreadHasPendingCanonicalSync(outsideWindow)).toBe(true);
  });

  it("keeps synchronization pending across a concurrent read without downgrading the terminal receipt", () => {
    const before = thread();
    const completed = presentControlRunTerminal(before, "first", terminal);
    const read = preserveControlRunSynchronizations(
      completed,
      before,
      new Set(["first"]),
    );
    expect(read.turns[0]!.status).toBe("completed");
    expect(read.turns[1]!.status).toBe("inProgress");
    expect(controlThreadHasPendingCanonicalSync(read)).toBe(true);
    expect(
      controlThreadHasPendingCanonicalSync(
        clearControlRunSynchronization(read, "second"),
      ),
    ).toBe(true);
    expect(
      controlThreadHasPendingCanonicalSync(
        clearControlRunSynchronization(read, "first"),
      ),
    ).toBe(false);
  });

  it("keeps the thread-wide replay guard when a history page omits the pending Run", () => {
    const completed = presentControlRunTerminal(thread(), "first", terminal);
    const incoming = { ...thread(), turns: [] };
    const paged = preserveControlRunSynchronizations(
      completed,
      incoming,
      new Set(["first"]),
    );
    expect(controlThreadHasPendingCanonicalSync(paged)).toBe(true);
    expect(
      controlThreadHasPendingCanonicalSync(
        clearControlRunSynchronization(paged, "first"),
      ),
    ).toBe(false);
  });

  it("keeps the terminal thread idle across a stale read and retains a Run-local preview", () => {
    const before = thread();
    before.turns = before.turns.slice(0, 1);
    const preview = {
      localId: "pending-reply:first",
      text: "真实收到的回复",
      partial: false,
    };
    const completed = presentControlRunTerminal(before, "first", {
      ...terminal,
      draftPreview: preview,
    });
    const read = preserveControlRunSynchronizations(
      completed,
      before,
      new Set(["first"]),
    );
    expect(read.status.type).toBe("idle");
    expect(controlPendingReplyDraft(read.turns[0]!)).toEqual(preview);
    const updated = updateControlPendingReplyDraft(read, "first", {
      ...preview,
      text: "已恢复的完整回复",
    });
    expect(controlPendingReplyDraft(updated.turns[0]!)?.text).toBe(
      "已恢复的完整回复",
    );
    expect(
      controlPendingReplyDraft(
        clearControlRunSynchronization(updated, "first").turns[0]!,
      ),
    ).toBeNull();
    expect(updated.turns[0]!.items).toBe(before.turns[0]!.items);
  });

  it("projects a genuine failure receipt and makes an otherwise finished Thread idle", () => {
    const before = thread();
    before.turns = before.turns.slice(0, 1);
    const result = presentControlRunTerminal(before, "first", {
      ...terminal,
      status: "failed",
      failure: {
        code: "responses_provider_server_is_overloaded",
        retryable: true,
      },
    });
    expect(result.status.type).toBe("idle");
    expect(result.turns[0]!.error?.message).toBe(
      "responses_provider_server_is_overloaded",
    );
    expect(result.turns[0]!.items).toEqual(before.turns[0]!.items);
  });

  it("rejects nonterminal or malformed receipts before any presentation changes", () => {
    expect(() =>
      controlRunTerminal({ ...terminal, status: "running" }),
    ).toThrow("control_run_terminal_receipt_invalid");
    expect(() => controlRunTerminal({ ...terminal, lastSequence: -1 })).toThrow(
      "control_run_terminal_receipt_invalid",
    );
    expect(() =>
      controlRunTerminal({ ...terminal, terminalAt: "bad date" }),
    ).toThrow("control_run_terminal_receipt_invalid");
  });
});
