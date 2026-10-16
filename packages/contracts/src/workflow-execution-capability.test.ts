import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowExecutionCapability } from "./workflow-execution-capability.ts";
test("Workflow capability distinguishes partial read support from durable admission and rejects ambiguous grants", () => {
  for (const value of [
    { version: "v1", admission: false, snapshots: false, humanGates: false },
    { version: "v1", admission: false, snapshots: true, humanGates: true },
    { version: "v1", admission: true, snapshots: true, humanGates: true },
    { version: "v1", admission: true, snapshots: false, humanGates: false },
  ])
    assert.deepEqual(parseWorkflowExecutionCapability(value), value);
  for (const value of [
    null,
    {},
    { version: "v2", admission: true, snapshots: true, humanGates: true },
    { version: "v1", admission: "true", snapshots: false, humanGates: true },
    { version: "v1", admission: true, snapshots: true, humanGates: "yes" },
    {
      version: "v1",
      admission: true,
      snapshots: true,
      humanGates: true,
      workerOnline: true,
    },
  ])
    assert.throws(() => parseWorkflowExecutionCapability(value));
  let reads = 0;
  const value = {
    version: "v1",
    get admission() {
      reads++;
      return true;
    },
    snapshots: true,
    humanGates: true,
  };
  assert.throws(() => parseWorkflowExecutionCapability(value));
  assert.equal(reads, 0);
});
