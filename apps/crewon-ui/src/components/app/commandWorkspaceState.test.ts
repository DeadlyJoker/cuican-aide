import { describe, expect, it } from "vitest";

import {
  readThreadExecutionTarget,
  shouldResetExecutionTarget,
  writeThreadExecutionTarget,
} from "./commandWorkspaceState";

describe("command workspace execution target state", () => {
  it("restores the selected execution target for each thread", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeThreadExecutionTarget(storage, "thread-1", "team:office-version-1");
    writeThreadExecutionTarget(storage, "thread-2", "agent:agent-version-2");

    expect({
      first: readThreadExecutionTarget(storage, "thread-1"),
      second: readThreadExecutionTarget(storage, "thread-2"),
      missing: readThreadExecutionTarget(storage, "thread-3"),
    }).toEqual({
      first: "team:office-version-1",
      second: "agent:agent-version-2",
      missing: null,
    });
  });

  it("ignores malformed persisted execution-target state", () => {
    const storage = {
      getItem: () => "{not-json",
      setItem: () => undefined,
    };

    expect(readThreadExecutionTarget(storage, "thread-1")).toBeNull();
  });

  it("preserves a selected target while its catalog is refreshing", () => {
    const transitions = [
      {
        state: "loading target temporarily absent",
        reset: shouldResetExecutionTarget({
          catalogStatus: "loading",
          optionAvailable: false,
          selectedProviderAgentMatches: true,
        }),
      },
      {
        state: "temporarily unavailable while reconnecting",
        reset: shouldResetExecutionTarget({
          catalogStatus: "unavailable",
          optionAvailable: false,
          selectedProviderAgentMatches: true,
        }),
      },
      {
        state: "ready target restored",
        reset: shouldResetExecutionTarget({
          catalogStatus: "ready",
          optionAvailable: true,
          selectedProviderAgentMatches: true,
        }),
      },
      {
        state: "ready target removed",
        reset: shouldResetExecutionTarget({
          catalogStatus: "ready",
          optionAvailable: false,
          selectedProviderAgentMatches: true,
        }),
      },
    ];

    expect(transitions).toMatchInlineSnapshot(`
      [
        {
          "reset": false,
          "state": "loading target temporarily absent",
        },
        {
          "reset": false,
          "state": "temporarily unavailable while reconnecting",
        },
        {
          "reset": false,
          "state": "ready target restored",
        },
        {
          "reset": true,
          "state": "ready target removed",
        },
      ]
    `);
  });
});
