import { describe, expect, it } from "vitest";

import type { OfficeRunActivity, OfficeWorkspace } from "../domain/crewonDomain";
import {
  confirmLegacyOfficeIdle,
  deriveOfficeComposerRuntimeState,
  officeWorkspaceHasNonterminalRun,
} from "./officeComposerRuntime";
import type { Thread } from "@crewon-protocol/v2/Thread";

function workspace(runs: OfficeRunActivity[] = []): OfficeWorkspace {
  return {
    goal: "Ship safely",
    members: [],
    messages: [],
    tasks: [],
    activity: { runs },
  };
}

function run(
  overrides: Partial<OfficeRunActivity> = {},
): OfficeRunActivity {
  return {
    id: "run-1",
    title: "Run",
    status: "running",
    threadId: "manager-thread",
    turnId: "manager-turn",
    ...overrides,
  };
}

describe("Office composer runtime state", () => {
  it("recognizes an active manager only from the exact active turn", () => {
    expect(
      deriveOfficeComposerRuntimeState(workspace([run()]), {
        "manager-thread": "manager-turn",
      }),
    ).toEqual({ mode: "managerActive", run: run() });
  });

  it("keeps an active conversation distinct from an actionable manager run", () => {
    const conversation = run({ messageIntent: "conversation" });
    expect(
      deriveOfficeComposerRuntimeState(workspace([conversation]), {
        "manager-thread": "manager-turn",
      }),
    ).toEqual({ mode: "managerConversationActive", run: conversation });
  });

  it("recognizes explicit child activity after the manager turn ends", () => {
    const childRun = run({
      delegations: [
        {
          id: "delegation-1",
          member: "Reviewer",
          status: "running",
        },
      ],
    });
    expect(deriveOfficeComposerRuntimeState(workspace([childRun]))).toEqual({
      mode: "childActive",
      run: childRun,
    });
  });

  it("fails safe to queued when a running owner cannot be proven", () => {
    expect(deriveOfficeComposerRuntimeState(workspace([run()]))).toEqual({
      mode: "queued",
      run: run(),
    });
  });

  it("fails safe to queued when the exact Office thread has an active turn but no run projection", () => {
    expect(
      deriveOfficeComposerRuntimeState(
        workspace([]),
        { "manager-thread": "manager-turn" },
      ),
    ).toEqual({ mode: "idle", run: null });
    expect(
      deriveOfficeComposerRuntimeState(
        { ...workspace([]), threadId: "manager-thread" },
        { "manager-thread": "manager-turn" },
      ),
    ).toEqual({ mode: "queued", run: null });
  });

  it("prioritizes canceling and detects all nonterminal run states", () => {
    const queued = run({ id: "run-queued", status: "queued" });
    const canceling = run({ id: "run-canceling", status: "canceling" });
    const target = workspace([queued, canceling]);

    expect(deriveOfficeComposerRuntimeState(target)).toEqual({
      mode: "canceling",
      run: canceling,
    });
    expect(officeWorkspaceHasNonterminalRun(target)).toBe(true);
    expect(
      officeWorkspaceHasNonterminalRun(
        workspace([run({ status: "completed" })]),
      ),
    ).toBe(false);
  });

  it("confirms legacy fallback only from an exact idle thread read", async () => {
    const idleThread = {
      status: { type: "idle" },
      turns: [{ status: "completed" }],
    } as Thread;
    await expect(
      confirmLegacyOfficeIdle({
        activeTurnByThread: {},
        isMissingThreadError: () => false,
        readThread: async () => idleThread,
        workspace: { ...workspace([]), threadId: "manager-thread" },
      }),
    ).resolves.toBe("confirmedIdle");
    await expect(
      confirmLegacyOfficeIdle({
        activeTurnByThread: { "manager-thread": "manager-turn" },
        isMissingThreadError: () => false,
        readThread: async () => idleThread,
        workspace: { ...workspace([]), threadId: "manager-thread" },
      }),
    ).resolves.toBe("deny");
    await expect(
      confirmLegacyOfficeIdle({
        activeTurnByThread: {},
        isMissingThreadError: () => false,
        readThread: async () =>
          ({
            status: { type: "idle" },
            turns: [{ status: "inProgress" }],
          }) as Thread,
        workspace: { ...workspace([]), threadId: "manager-thread" },
      }),
    ).resolves.toBe("deny");
  });

  it("allows a missing thread to be recreated but denies unknown read failures", async () => {
    const missing = new Error("missing");
    await expect(
      confirmLegacyOfficeIdle({
        activeTurnByThread: {},
        isMissingThreadError: (error) => error === missing,
        readThread: async () => {
          throw missing;
        },
        workspace: { ...workspace([]), threadId: "missing-thread" },
      }),
    ).resolves.toBe("missingThread");
    await expect(
      confirmLegacyOfficeIdle({
        activeTurnByThread: {},
        isMissingThreadError: () => false,
        readThread: async () => {
          throw new Error("network");
        },
        workspace: { ...workspace([]), threadId: "manager-thread" },
      }),
    ).resolves.toBe("deny");
  });
});
