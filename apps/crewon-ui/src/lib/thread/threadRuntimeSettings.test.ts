import { describe, expect, it } from "vitest";

import { commandComposerRuntimeSettings } from "./threadRuntimeSettings";

describe("thread runtime settings", () => {
  it("maps command composer permission choices to thread runtime settings", () => {
    expect(
      commandComposerRuntimeSettings({
        model: "gpt-5.6-sol",
        permission: "approve-for-me",
      }),
    ).toEqual({
      approvalPolicy: "on-failure",
      executionIntent: "none",
      model: "gpt-5.6-sol",
      sandboxMode: "workspace-write",
    });
    expect(
      commandComposerRuntimeSettings({
        model: "gpt-5.5",
        permission: "request-approval",
      }),
    ).toEqual({
      approvalPolicy: "on-request",
      executionIntent: "none",
      model: "gpt-5.5",
      sandboxMode: "workspace-write",
    });
    expect(
      commandComposerRuntimeSettings({
        model: "gpt-5",
        permission: "full-access",
      }),
    ).toEqual({
      approvalPolicy: "never",
      executionIntent: "none",
      model: "gpt-5",
      sandboxMode: "danger-full-access",
    });
  });

  it("includes the selected execution intent", () => {
    expect(
      commandComposerRuntimeSettings({
        executionIntent: "plan",
        model: "gpt-5.6-sol",
        permission: "approve-for-me",
      }),
    ).toMatchObject({ executionIntent: "plan" });
  });

  it("adds scene identity and a target id without deriving the execution strategy", () => {
    expect(
      commandComposerRuntimeSettings({
        executionTarget: "team:交付小队",
        model: "gpt-5.6-sol",
        permission: "approve-for-me",
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

  it("keeps an Experts selection as a distinct single-chat execution target", () => {
    expect(
      commandComposerRuntimeSettings({
        executionTarget: "experts:experts-code-review",
        model: "gpt-5.6-sol",
        permission: "approve-for-me",
        scene: "code",
        sceneMode: "review",
      }),
    ).toMatchObject({
      scene: {
        sceneId: "code",
        mode: "review",
        executionTarget: {
          kind: "experts",
          id: "experts-code-review",
        },
      },
    });
  });

  it("keeps Provider Resource Agent authority outside ordinary thread settings", () => {
    expect(
      commandComposerRuntimeSettings({
        executionTarget: "provider-agent:opaque-selection",
        model: "gpt-5.6-sol",
        permission: "approve-for-me",
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
