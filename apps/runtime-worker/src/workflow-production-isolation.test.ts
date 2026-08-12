import assert from "node:assert/strict";
import test from "node:test";

import * as productionRuntime from "./index.ts";

test("keeps experimental Workflow execution out of production runtime exports", () => {
  assert.equal("WorkflowDagExecutor" in productionRuntime, false);
  assert.equal(
    "ExperimentalWorkflowRunCompositionAdapter" in productionRuntime,
    false,
  );
});
