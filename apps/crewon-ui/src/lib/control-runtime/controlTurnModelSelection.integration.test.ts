// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readThreadModelSelection,
  writeThreadModelSelection,
} from "../thread/threadModelSelection";
import { transcriptFixture } from "./controlTranscriptWindow.test-support";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("accepted Control turn model preferences", () => {
  it("remembers the accepted model for a new conversation's precise identity", async () => {
    const fixture = transcriptFixture(0);
    writeThreadModelSelection("other-conversation", "other-model");
    try {
      await fixture.runtime.startTurn("thread-1", "First request", [], {
        model: "model-1",
      });
      expect(readThreadModelSelection("thread-1")?.modelId).toBe("model-1");
      expect(readThreadModelSelection("other-conversation")?.modelId).toBe(
        "other-model",
      );
    } finally {
      fixture.runtime.close();
    }
  });

  it("does not save a model when startTurn fails", async () => {
    const fixture = transcriptFixture(0);
    vi.spyOn(fixture.client, "startTurn").mockRejectedValue(
      new Error("fixture rejected turn"),
    );
    try {
      await expect(
        fixture.runtime.startTurn("thread-1", "First request", [], {
          model: "model-1",
        }),
      ).rejects.toThrow("fixture rejected turn");
      expect(readThreadModelSelection("thread-1")).toBeNull();
    } finally {
      fixture.runtime.close();
    }
  });

  it("preserves a model selected while an earlier turn request is pending", async () => {
    const fixture = transcriptFixture(0);
    const originalStartTurn = fixture.client.startTurn.bind(fixture.client);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredStart = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(fixture.client, "startTurn").mockImplementation(
      async (...args) => {
        entered();
        await pending;
        return originalStartTurn(...args);
      },
    );
    try {
      const request = fixture.runtime.startTurn(
        "thread-1",
        "First request",
        [],
        { model: "model-1" },
      );
      await enteredStart;
      writeThreadModelSelection("thread-1", "model-2");
      release();
      await request;
      expect(readThreadModelSelection("thread-1")?.modelId).toBe("model-2");
    } finally {
      release();
      fixture.runtime.close();
    }
  });

  it("does not remember a mismatched receipt identity", async () => {
    const fixture = transcriptFixture(0);
    const originalStartTurn = fixture.client.startTurn.bind(fixture.client);
    vi.spyOn(fixture.client, "startTurn").mockImplementation(
      async (...args) => {
        const response = await originalStartTurn(...args);
        return {
          ...response,
          run: { ...response.run, threadId: "other-conversation" },
        };
      },
    );
    try {
      await fixture.runtime.startTurn("thread-1", "First request", [], {
        model: "model-1",
      });
      expect(readThreadModelSelection("thread-1")).toBeNull();
      expect(readThreadModelSelection("other-conversation")).toBeNull();
    } finally {
      fixture.runtime.close();
    }
  });
});
