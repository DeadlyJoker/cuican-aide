import { afterEach, describe, expect, it, vi } from "vitest";
import { readControlTeamExecutionMode } from "./controlTeamExecutionMode";

afterEach(() => vi.unstubAllEnvs());

describe("experimental durable Team execution mode", () => {
  it("keeps the legacy path when the flag is absent or disabled", () => {
    expect(readControlTeamExecutionMode(undefined)).toBe("legacy");
    expect(readControlTeamExecutionMode("")).toBe("legacy");
    expect(readControlTeamExecutionMode("0")).toBe("legacy");
  });

  it("enables the durable path only for the exact opt-in value", () => {
    expect(readControlTeamExecutionMode("1")).toBe("durableTask");
  });

  it("rejects ambiguous flag values instead of silently changing execution", () => {
    expect(() => readControlTeamExecutionMode("true")).toThrow(
      "crewon_experimental_durable_team_tasks_invalid",
    );
  });
});
