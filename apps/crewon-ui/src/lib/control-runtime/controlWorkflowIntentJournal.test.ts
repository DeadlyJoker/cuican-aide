import { describe, expect, it, vi } from "vitest";
import {
  ControlWorkflowIntentJournal,
  type WorkflowIntent,
  type WorkflowIntentStorage,
} from "./controlWorkflowIntentJournal";
import { workflowIntentMemoryStorage } from "./controlWorkflowCommands.test-support";

const contextId = `sha256:${"a".repeat(64)}`;
const otherContext = `sha256:${"b".repeat(64)}`;
const start = () => ({
  contextId,
  workflowVersionId: "version-1",
  threadId: "thread-1",
  command: {
    kind: "start" as const,
    body: {
      workflowVersionId: "version-1",
      threadId: "thread-1",
      input: { topic: "  原文\n" },
    },
  },
});
function journal(storage = workflowIntentMemoryStorage(), id = "intent-1") {
  return new ControlWorkflowIntentJournal({
    storage: () => storage,
    nextId: () => id,
    now: () => "2026-10-17T00:00:00.000Z",
  });
}
function key(storage: WorkflowIntentStorage) {
  return storage.key(0)!;
}

describe("immutable Workflow intent journal", () => {
  it("keeps two windows' intents independently and restores the original body after reopen", () => {
    const storage = workflowIntentMemoryStorage();
    const first = journal(storage, "intent-1").create(start());
    const second = journal(storage, "intent-2").create({
      ...start(),
      contextId: otherContext,
    });
    const reopened = journal(storage, "unused");
    expect(reopened.list(contextId)).toEqual([first]);
    expect(reopened.list(otherContext)).toEqual([second]);
    reopened.acknowledge(first);
    expect(reopened.list(contextId)).toEqual([]);
    expect(reopened.get(second.id)).toEqual(second);
    expect(() => reopened.get(first.id)).toThrow("workflow_intent_missing");
    reopened.acknowledge(first);
    expect(storage.length).toBe(1);
  });

  it("does not let caller mutations rewrite stored input, mode or returned values", () => {
    const storage = workflowIntentMemoryStorage(),
      owner = journal(storage);
    const input = start();
    const first = owner.create(input);
    input.command.body.input.topic = "changed";
    if (first.command.kind === "start")
      first.command.body.input = { topic: "mutated clone" };
    expect(owner.get(first.id).command).toEqual(start().command);
    const restored = owner.get(first.id);
    if (restored.command.kind === "start") restored.command.body.input = null;
    expect(owner.get(first.id).command).toEqual(start().command);
  });

  it.each([undefined, "descendants-v1" as const])(
    "preserves review comment and mode %s on reopen",
    (mode) => {
      const storage = workflowIntentMemoryStorage(),
        owner = journal(storage);
      const original = owner.create({
        ...start(),
        command: {
          kind: "review",
          locator: {
            runId: "run-1",
            nodeId: "gate",
            gateRequestId: "request-1",
          },
          body: {
            inputDigest: contextId,
            decision: "approved",
            comment: "  同意\n保持原文  ",
            ...(mode ? { commentContext: mode } : {}),
          },
        },
      });
      expect(journal(storage).get(original.id)).toEqual(original);
      expect(
        Object.hasOwn(
          (
            original.command as Extract<
              WorkflowIntent["command"],
              { kind: "review" }
            >
          ).body,
          "commentContext",
        ),
      ).toBe(mode !== undefined);
    },
  );

  it("refuses key reuse and refuses to acknowledge a changed stored intent", () => {
    const storage = workflowIntentMemoryStorage(),
      owner = journal(storage);
    const original = owner.create(start());
    expect(() => owner.create({ ...start(), contextId: otherContext })).toThrow(
      "workflow_intent_changed",
    );
    storage.setItem(
      key(storage),
      JSON.stringify({ ...original, contextId: otherContext }),
    );
    expect(() => owner.acknowledge(original)).toThrow(
      "workflow_intent_changed",
    );
    expect(storage.length).toBe(1);
  });

  it("fails closed for corrupt and oversized entries without deleting them", () => {
    const storage = workflowIntentMemoryStorage();
    journal(storage).create(start());
    const storageKey = key(storage);
    for (const text of [
      "{broken",
      "x".repeat(65537),
      JSON.stringify({
        ...start(),
        version: "v1",
        id: "intent-1",
        createdAt: "bad",
      }),
    ]) {
      storage.setItem(storageKey, text);
      expect(() => journal(storage).list(contextId)).toThrow(
        "workflow_intent_corrupt",
      );
      expect(storage.getItem(storageKey)).toBe(text);
    }
  });

  it("bounds discovery and preserves all prior entries on capacity refusal", () => {
    const storage = workflowIntentMemoryStorage();
    for (let index = 0; index < 32; index++)
      journal(storage, `intent-${index}`).create(start());
    expect(() => journal(storage, "intent-overflow").create(start())).toThrow(
      "workflow_intent_capacity",
    );
    expect(journal(storage).list(contextId)).toHaveLength(32);
    const many = { ...storage, length: 4097, key: vi.fn(() => null) };
    expect(() => journal(many).list(contextId)).toThrow(
      "workflow_intent_capacity",
    );
    expect(many.key).not.toHaveBeenCalled();
  });

  it("requires durable storage read-back and exposes unavailable storage", () => {
    const owner = journal({
      ...workflowIntentMemoryStorage(),
      setItem() {
        throw new Error("quota");
      },
    });
    expect(() => owner.create(start())).toThrow(
      "workflow_intent_storage_unavailable",
    );
    expect(() =>
      journal({ ...workflowIntentMemoryStorage(), setItem() {} }).create(
        start(),
      ),
    ).toThrow("workflow_intent_changed");
    expect(() =>
      new ControlWorkflowIntentJournal({
        storage() {
          throw Error("disabled");
        },
      }).list(contextId),
    ).toThrow("workflow_intent_storage_unavailable");
  });

  it("rejects accessor/extra/symbol data before invoking it or serializing", () => {
    const storage = workflowIntentMemoryStorage(),
      owner = journal(storage);
    const value = start(),
      getter = vi.fn(() => "changed");
    Object.defineProperty(value.command.body.input, "topic", {
      enumerable: true,
      get: getter,
    });
    expect(() => owner.create(value)).toThrow("workflow_intent_corrupt");
    expect(getter).not.toHaveBeenCalled();
    expect(storage.length).toBe(0);
    const symbol = start();
    Object.defineProperty(symbol.command.body.input, Symbol("unexpected"), {
      enumerable: true,
      value: "bad",
    });
    expect(() => owner.create(symbol)).toThrow("workflow_intent_corrupt");
    expect(() =>
      owner.create({ ...start(), threadId: "another-thread" }),
    ).toThrow("workflow_intent_corrupt");
  });
});
