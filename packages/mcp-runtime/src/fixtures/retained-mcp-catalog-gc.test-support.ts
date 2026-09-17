import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  InMemoryToolBroker,
  processToolResultCapacity,
} from "@crewon/tool-broker";
import { McpToolRuntime } from "../mcp-tool-runtime.ts";
import {
  executionCommand,
  readOnlyPolicy,
} from "../mcp-tool-runtime.test-support.ts";

assert.ok(global.gc !== undefined, "This isolated test requires --expose-gc");
const original = InMemoryToolBroker.prototype.definitions;
const generations: WeakRef<InMemoryToolBroker>[] = [];
InMemoryToolBroker.prototype.definitions = function () {
  generations.push(new WeakRef(this));
  return original.call(this);
};
let executions = 0;
const tools = new McpToolRuntime({
  serverId: "fixture",
  policies: new Map([["echo", readOnlyPolicy()]]),
  client: {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({
      tools: [
        {
          name: "echo",
          description: "Stable tool",
          inputSchema: { type: "object", description: "schema".repeat(5000) },
        },
      ],
    }),
    callTool: async () => {
      executions++;
      return { content: [{ type: "text", text: "retained result" }] };
    },
  },
});
const command = executionCommand();
try {
  await tools.connect(new AbortController().signal);
  const result = await tools.execute(command, new AbortController().signal);
  for (let i = 0; i < 1000; i++)
    await tools.refresh(new AbortController().signal);
  InMemoryToolBroker.prototype.definitions = original;
  // WeakRef targets survive their current job; cross jobs before requesting test-only GC.
  for (let i = 0; i < 5; i++) {
    await nextTurn();
    global.gc();
  }
  await nextTurn();
  const live = new Set(
    generations
      .map((generation) => generation.deref())
      .filter((value) => value !== undefined),
  );
  assert.ok(generations.length >= 1000);
  assert.ok(live.size <= 2, `retained ${live.size} broker generations`);
  assert.deepEqual(tools.readRetainedExecutionResult(command), result);
  assert.equal(executions, 1);
  await tools.close();
  tools.acknowledgeExecutionResult({
    ...command,
    status: "completed",
    providerReceiptId: result.providerReceiptId,
  });
  assert.equal(processToolResultCapacity.resourceSnapshot().reservedBytes, 0);
  process.stdout.write(
    JSON.stringify({
      refreshes: 1000,
      liveBrokerGenerations: live.size,
      executions,
      retainedBytesAfterAck: 0,
    }),
  );
} finally {
  InMemoryToolBroker.prototype.definitions = original;
  await tools.close();
}
