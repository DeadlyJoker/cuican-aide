import { describe, expect, it } from "vitest";
import type { MessageView, RunView } from "@crewon/contracts";
import {
  ControlTurnRunIndex,
  groupControlTurnMessages,
} from "./controlTurnProjectionIndex";

const run = (
  id: number,
  time: number,
  overrides: Partial<RunView> = {},
): RunView =>
  ({
    runId: `run-${id}`,
    createdAt: new Date(time).toISOString(),
    status: "completed",
    purpose: "turn",
    ...overrides,
  }) as RunView;
const message = (
  sequence: number,
  role: MessageView["role"],
  content: string,
): MessageView => ({
  messageId: `message-${sequence}`,
  threadId: "thread-1",
  sequence,
  role,
  content,
  createdAt: new Date(sequence).toISOString(),
  proposedPlan: null,
});

// The former full-filter projection is the compatibility oracle, including its
// API-order priority and excluded-terminal fallback after rollback.
function reference(
  runs: readonly RunView[],
  included: ReadonlySet<string> | null,
  start: number,
  end: number,
) {
  const candidates = [...runs].reverse().filter((candidate) => {
    const time = Date.parse(candidate.createdAt);
    return (
      (candidate.purpose ?? "turn") === "turn" && time >= start && time < end
    );
  });
  const terminal = (candidate: RunView) =>
    ["completed", "failed", "canceled"].includes(candidate.status);
  return included === null
    ? (candidates.at(-1) ?? null)
    : (candidates
        .filter(
          (candidate) => !terminal(candidate) || included.has(candidate.runId),
        )
        .at(-1) ??
        candidates.find(
          (candidate) => terminal(candidate) && !included.has(candidate.runId),
        ) ??
        null);
}

describe("Control turn projection index", () => {
  it("groups sequence gaps and internal Team reports without losing direct member answers", () => {
    const messages = [
      message(1, "assistant", "orphan"),
      message(3, "user", "first task"),
      message(4, "assistant", "first answer"),
      message(7, "user", "[Team Runtime · Office · 成员报告]\nreport"),
      message(8, "assistant", "leader answer"),
      message(12, "user", "[Team Runtime · Office · 成员直答]\nmember context"),
      message(13, "assistant", "member answer"),
      message(20, "user", "second task"),
      message(22, "assistant", "second answer"),
      message(23, "user", "[Team Runtime recovery report]\nrecovery"),
    ];
    expect(groupControlTurnMessages(messages)).toEqual([
      {
        user: messages[1],
        assistants: [messages[2], messages[4], messages[6]],
        hasTeamMemberDirectResponse: true,
      },
      {
        user: messages[7],
        assistants: [messages[8]],
        hasTeamMemberDirectResponse: false,
      },
    ]);
    expect(groupControlTurnMessages([])).toEqual([]);
  });

  it.each(
    [[2, 1], [1, 1], [0], [1.5], [Number.MAX_SAFE_INTEGER + 1]].map(
      (sequences) => ({ sequences }),
    ),
  )("rejects ambiguous message sequence order %j", ({ sequences }) => {
    expect(() =>
      groupControlTurnMessages(
        sequences.map((sequence) => ({
          ...message(1, "user", "task"),
          sequence,
        })),
      ),
    ).toThrow("control_message_sequence_invalid");
  });

  it("matches the original selector with retries, same timestamps, clock regression and rollback", () => {
    let state = 341;
    const random = (limit: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % limit;
    };
    for (let sample = 0; sample < 40; sample++) {
      const runs = Array.from({ length: 160 }, (_, id) =>
        run(id, random(40), {
          purpose: random(4) === 0 ? "manualCompaction" : "turn",
          status: (
            [
              "completed",
              "failed",
              "canceled",
              "running",
              "waitingApproval",
            ] as const
          )[random(5)]!,
        }),
      );
      const included =
        sample % 3 === 0
          ? null
          : new Set(
              runs
                .filter(() => random(3) === 0)
                .map((candidate) => candidate.runId),
            );
      const index = new ControlTurnRunIndex(runs, included);
      for (let interval = 0; interval < 100; interval++) {
        const start = random(45);
        const end = interval % 7 === 0 ? Number.POSITIVE_INFINITY : random(45);
        expect(index.find(start, end)).toBe(
          reference(runs, included, start, end),
        );
      }
    }
  });

  it("preserves API order over creation order and falls back only if no effective Run exists", () => {
    const runs = [run(1, 15), run(2, 40), run(3, 20)];
    expect(new ControlTurnRunIndex(runs, null).find(0, 50)).toBe(runs[0]);
    expect(new ControlTurnRunIndex(runs, new Set()).find(0, 50)).toBe(runs[2]);
    expect(new ControlTurnRunIndex(runs, new Set(["run-2"])).find(0, 50)).toBe(
      runs[1],
    );
    expect(new ControlTurnRunIndex(runs, null).find(15, 20)).toBe(runs[0]);
    expect(new ControlTurnRunIndex(runs, null).find(20, 40)).toBe(runs[2]);
    expect(new ControlTurnRunIndex([], null).find(0, Infinity)).toBeNull();
  });

  it("reads each Run timestamp once for twenty thousand Runs and five thousand turns", () => {
    let reads = 0;
    const runs = Array.from({ length: 20_000 }, (_, id) => {
      const candidate = run(id, id);
      const createdAt = candidate.createdAt;
      Object.defineProperty(candidate, "createdAt", {
        get() {
          reads++;
          return createdAt;
        },
      });
      return candidate;
    }).reverse();
    const index = new ControlTurnRunIndex(runs, null);
    for (let turn = 0; turn < 5_000; turn++)
      expect(index.find(turn * 4, turn * 4 + 4)?.runId).toBe(
        `run-${turn * 4 + 3}`,
      );
    expect(reads).toBe(20_000);
  });
});

it("keeps historical Office handoff instructions private and preserves every actual member response", () => {
  const original = message(1, "user", "核对运费");
  const handoff = message(
    2,
    "user",
    "[Team Runtime · 泊川生鲜 · 办公室交接]\n请遵循角色设定与授权成员标记",
  );
  const first = message(3, "assistant", "沈筹：请苏算核算");
  const second = message(5, "assistant", "苏算：运输合计684元");
  const groups = groupControlTurnMessages([
    original,
    handoff,
    first,
    { ...handoff, sequence: 4 },
    second,
  ]);
  expect(groups).toEqual([
    {
      user: original,
      assistants: [first, second],
      hasTeamMemberDirectResponse: true,
    },
  ]);
  expect(handoff.content).toContain("授权成员标记");
});
