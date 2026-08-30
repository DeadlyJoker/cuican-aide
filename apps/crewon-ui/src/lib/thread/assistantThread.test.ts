import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_AUTO_COMPACT_TOKEN_LIMIT,
  assistantThreadRuntimeSettings,
  latestAssistantThread,
} from "./assistantThread";

function thread(id: string, threadSource: string, updatedAt: number): Thread {
  return {
    id,
    threadSource,
    updatedAt,
    createdAt: updatedAt,
    turns: [],
  } as unknown as Thread;
}

describe("assistant thread", () => {
  it("selects only the latest dedicated assistant conversation", () => {
    expect(
      latestAssistantThread([
        thread("regular", "app_server", 10),
        thread("assistant-old", "assistant", 20),
        thread("assistant-current", "assistant", 30),
      ])?.id,
    ).toBe("assistant-current");
  });

  it("adds bounded automatic context compaction without replacing settings", () => {
    expect(
      assistantThreadRuntimeSettings({
        model: "gpt-test",
        config: { include_permissions_instructions: false },
      }),
    ).toEqual({
      model: "gpt-test",
      threadSource: "assistant",
      config: {
        include_permissions_instructions: false,
        model_auto_compact_token_limit: ASSISTANT_AUTO_COMPACT_TOKEN_LIMIT,
        model_auto_compact_token_limit_scope: "total",
      },
    });
  });
});
