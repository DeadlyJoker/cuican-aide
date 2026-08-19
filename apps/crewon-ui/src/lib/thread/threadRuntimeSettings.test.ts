import { describe, expect, it } from "vitest";

import { commandComposerRuntimeSettings } from "./threadRuntimeSettings";

describe("thread runtime settings", () => {
  it("keeps unsupported per-turn permission claims out of composer settings", () => {
    expect(
      commandComposerRuntimeSettings({
        model: "gpt-5.6-sol",
      }),
    ).toEqual({
      executionIntent: "none",
      model: "gpt-5.6-sol",
    });
  });

  it("includes the selected execution intent", () => {
    expect(
      commandComposerRuntimeSettings({
        executionIntent: "plan",
        model: "gpt-5.6-sol",
      }),
    ).toMatchObject({ executionIntent: "plan" });
  });

  it("adds scene identity and a target id without deriving the execution strategy", () => {
    expect(
      commandComposerRuntimeSettings({
        executionTarget: "team:交付小队",
        model: "gpt-5.6-sol",
        scene: "design",
        sceneMode: "produce",
      }),
    ).toMatchObject({
      scene: {
        sceneId: "design",
        mode: "produce",
        executionTarget: { kind: "team", id: "交付小队" },
      },
    });
  });

  it("keeps Provider Resource Agent authority outside ordinary thread settings", () => {
    expect(
      commandComposerRuntimeSettings({
        executionTarget: "provider-agent:opaque-selection",
        model: "gpt-5.6-sol",
        scene: "office",
        sceneMode: "auto",
      }),
    ).toMatchObject({
      scene: {
        executionTarget: { kind: "crewon" },
      },
    });
  });
});
