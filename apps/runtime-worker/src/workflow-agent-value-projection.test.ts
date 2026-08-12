import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkflowNodeOutput,
  workflowNodeInputHistory,
} from "./workflow-agent-value-projection.ts";

const node = {
  nodeId: "analyze",
  title: "Analyze",
  instruction: "Return structured evidence.",
  kind: "agent" as const,
  agentVersionId: "agent-v2",
  dependsOn: [],
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      answer: {
        type: "string" as const,
        maxLength: 32,
        enum: null,
      },
    },
    required: ["answer"],
    additionalProperties: false as const,
  },
};

test("projects actual canonical input instead of a digest", () => {
  const history = workflowNodeInputHistory({
    node,
    value: { question: "why", nested: [1, true] },
  });
  assert.equal(history.length, 1);
  assert.match(
    history[0]!.type === "message" ? history[0]!.content : "",
    /"question":"why","nested":\[1,true\]/,
  );
});

test("accepts only bounded exact JSON matching the frozen output schema", () => {
  assert.deepEqual(parseWorkflowNodeOutput('{"answer":"done"}', node), {
    answer: "done",
  });
  assert.throws(
    () => parseWorkflowNodeOutput("```json\n{}\n```", node),
    /workflow_node_output_json_invalid/,
  );
  assert.throws(
    () => parseWorkflowNodeOutput('{"answer":"done","extra":true}', node),
    /workflow_value_schema_mismatch/,
  );
});
