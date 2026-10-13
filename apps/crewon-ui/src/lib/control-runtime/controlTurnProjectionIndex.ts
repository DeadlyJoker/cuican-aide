import type { MessageView, RunView } from "@crewon/contracts";

export type ControlTurnMessages = {
  user: MessageView;
  assistants: MessageView[];
  hasTeamMemberDirectResponse: boolean;
};

function isTeamMemberDirect(content: string): boolean {
  return /^\[Team Runtime · [^\n]{1,256} · (?:成员直答|办公室交接)\](?:\n|$)/u.test(
    content,
  );
}

export function isInternalUserContent(content: string): boolean {
  return (
    /^\[Team Runtime · [^\n]{1,256} · 成员报告\](?:\n|$)/u.test(content) ||
    /^\[Team Runtime · [^\n]{1,256} · 组长汇总\](?:\n|$)/u.test(content) ||
    /^\[Team Runtime · [^\n]{1,256} · 专家会诊报告\](?:\n|$)/u.test(content) ||
    isTeamMemberDirect(content) ||
    /^\[Team Runtime recovery report\](?:\n|$)/u.test(content)
  );
}

/** Message pages are canonical ascending sequences; gaps after rollback are valid. */
export function groupControlTurnMessages(
  messages: readonly MessageView[],
): ControlTurnMessages[] {
  const groups: ControlTurnMessages[] = [];
  let current: ControlTurnMessages | undefined;
  let previousSequence = 0;
  for (const message of messages) {
    if (
      !Number.isSafeInteger(message.sequence) ||
      message.sequence <= previousSequence
    ) {
      throw new Error("control_message_sequence_invalid");
    }
    previousSequence = message.sequence;
    if (message.role === "user" && !isInternalUserContent(message.content)) {
      current = {
        user: message,
        assistants: [],
        hasTeamMemberDirectResponse: false,
      };
      groups.push(current);
    } else if (current && message.role === "assistant") {
      current.assistants.push(message);
    } else if (
      current &&
      message.role === "user" &&
      isTeamMemberDirect(message.content)
    ) {
      current.hasTeamMemberDirectResponse = true;
    }
  }
  return groups;
}

/**
 * Select in creation-time intervals without filtering every Run for every user.
 * Priority remains the original newest-first API order (updatedAt), which is
 * deliberately independent of createdAt. Ledger-excluded terminal Runs are only
 * a fallback, using the oldest API position exactly as the previous projection.
 */
export class ControlTurnRunIndex {
  readonly #runs: readonly RunView[];
  readonly #times: number[];
  readonly #leafCount: number;
  readonly #preferred: Float64Array;
  readonly #fallback: Float64Array;

  constructor(
    runsNewestFirst: readonly RunView[],
    effectiveTerminalRunIds: ReadonlySet<string> | null,
  ) {
    this.#runs = runsNewestFirst;
    const entries = runsNewestFirst
      .flatMap((run, priority) => {
        if ((run.purpose ?? "turn") !== "turn") return [];
        const time = Date.parse(run.createdAt);
        if (!Number.isFinite(time)) return [];
        const terminal =
          run.status === "completed" ||
          run.status === "failed" ||
          run.status === "canceled";
        return [
          {
            time,
            priority,
            preferred:
              effectiveTerminalRunIds === null ||
              !terminal ||
              effectiveTerminalRunIds.has(run.runId),
          },
        ];
      })
      .sort((left, right) => left.time - right.time);
    this.#times = entries.map((entry) => entry.time);
    let leafCount = 1;
    while (leafCount < entries.length) leafCount *= 2;
    this.#leafCount = leafCount;
    this.#preferred = new Float64Array(leafCount * 2).fill(
      Number.POSITIVE_INFINITY,
    );
    this.#fallback = new Float64Array(leafCount * 2).fill(-1);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.preferred) this.#preferred[leafCount + index] = entry.priority;
      else this.#fallback[leafCount + index] = entry.priority;
    }
    for (let index = leafCount - 1; index > 0; index--) {
      this.#preferred[index] = Math.min(
        this.#preferred[index * 2]!,
        this.#preferred[index * 2 + 1]!,
      );
      this.#fallback[index] = Math.max(
        this.#fallback[index * 2]!,
        this.#fallback[index * 2 + 1]!,
      );
    }
  }

  #lowerBound(time: number): number {
    let start = 0;
    let end = this.#times.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (this.#times[middle]! < time) start = middle + 1;
      else end = middle;
    }
    return start;
  }

  find(startInclusive: number, endExclusive: number): RunView | null {
    if (!(startInclusive < endExclusive)) return null;
    let left = this.#lowerBound(startInclusive) + this.#leafCount;
    let right = this.#lowerBound(endExclusive) + this.#leafCount;
    let preferred = Number.POSITIVE_INFINITY;
    let fallback = -1;
    while (left < right) {
      if (left % 2 !== 0) {
        preferred = Math.min(preferred, this.#preferred[left]!);
        fallback = Math.max(fallback, this.#fallback[left]!);
        left++;
      }
      if (right % 2 !== 0) {
        right--;
        preferred = Math.min(preferred, this.#preferred[right]!);
        fallback = Math.max(fallback, this.#fallback[right]!);
      }
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
    }
    const priority = Number.isFinite(preferred) ? preferred : fallback;
    return priority < 0 ? null : (this.#runs[priority] ?? null);
  }
}
