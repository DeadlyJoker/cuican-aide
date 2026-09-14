import { describe, expect, it } from "vitest";
import { currentWorkflowExecution } from "./currentWorkflowExecution";
import { workflowFixture } from "../workbench/taskWorkbenchFixture";

describe("fresh workflow submission isolation", () => {
  it("hides the prior PASS and cancel target until the new execution is projected", () => {
    const input = {
      persisted: workflowFixture,
      local: null,
      excludedExecutionId: workflowFixture.executionId,
    };
    expect(currentWorkflowExecution(input)).toBeNull();
    const current = {
      ...workflowFixture,
      executionId: "new-run",
      status: "running",
      output: "",
      executedNodes: [],
    };
    expect(currentWorkflowExecution({ ...input, persisted: current })).toBe(
      current,
    );
    expect(currentWorkflowExecution({ ...input, local: current })).toBe(
      current,
    );
  });
  it("preserves canceled local state over a delayed server projection", () => {
    const local = { ...workflowFixture, status: "canceled" };
    expect(
      currentWorkflowExecution({
        persisted: workflowFixture,
        local,
        excludedExecutionId: null,
      }),
    ).toBe(local);
  });
});
