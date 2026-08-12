import assert from "node:assert/strict";
import test from "node:test";

import * as productionRuntime from "./index.ts";

test("exports only the production dispatcher while keeping internal scheduler adapters private", () => {
  assert.equal(
    "ProductionWorkflowRuntimeDispatcher" in productionRuntime,
    true,
  );
  assert.equal("WorkflowDagExecutor" in productionRuntime, false);
  assert.equal(
    "ExperimentalWorkflowRunCompositionAdapter" in productionRuntime,
    false,
  );
});
