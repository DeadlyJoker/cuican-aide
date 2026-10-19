import { describe, expect, it } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import {
  controlRunModelActivity,
  preserveControlRunModelActivities,
  updateControlRunModelActivity,
} from "./controlRunModelActivity";

const thread = () =>
  ({
    id: "thread-1",
    turns: [
      { id: "run-1", status: "inProgress", items: [] },
      { id: "run-2", status: "completed", items: [] },
    ],
  }) as unknown as Thread;

describe("renderer-only Run model activity", () => {
  it("scopes activity to its existing active Run and preserves identity when unchanged", () => {
    const original = thread();
    expect(
      updateControlRunModelActivity(original, "foreign-run", "retrying"),
    ).toBe(original);
    expect(updateControlRunModelActivity(original, "run-2", "retrying")).toBe(
      original,
    );
    const waiting = updateControlRunModelActivity(original, "run-1", "waiting");
    expect(controlRunModelActivity(waiting.turns[0]!)).toBe("waiting");
    expect(updateControlRunModelActivity(waiting, "run-1", "waiting")).toBe(
      waiting,
    );
    expect(
      controlRunModelActivity(
        updateControlRunModelActivity(waiting, "run-1", null).turns[0]!,
      ),
    ).toBeNull();
  });

  it("preserves live activity through a stale read but never restores it to a terminal or different Run", () => {
    const current = updateControlRunModelActivity(
      thread(),
      "run-1",
      "retrying",
    );
    const incoming = thread();
    expect(
      controlRunModelActivity(
        preserveControlRunModelActivities(current, incoming).turns[0]!,
      ),
    ).toBe("retrying");
    const terminal = {
      ...incoming,
      turns: incoming.turns.map((turn) => ({
        ...turn,
        status: "failed" as const,
      })),
    };
    expect(preserveControlRunModelActivities(current, terminal)).toBe(terminal);
    expect(controlRunModelActivity(terminal.turns[0]!)).toBeNull();
    const foreign = {
      ...incoming,
      turns: [{ ...incoming.turns[0]!, id: "foreign-run" }],
    };
    expect(preserveControlRunModelActivities(current, foreign)).toBe(foreign);
  });
});
