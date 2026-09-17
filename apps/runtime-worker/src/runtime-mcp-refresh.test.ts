import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  McpRuntimeGroup,
  McpToolRuntime,
  StdioMcpClient,
} from "@crewon/mcp-runtime";
import {
  CompositeToolRuntime,
  type ToolExecutionPolicy,
} from "@crewon/tool-broker";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: real HTTP and stdio MCP continue after refresh and Store reopen without extra model or tool calls`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (context) => {
      const normalRuntime = await mcp(context);
      const normal = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        toolRuntime: normalRuntime.composite,
        toolName: "mcp__fixture__echo",
        toolInput: '{"value":"hello"}',
      });
      assert.equal((await normal.worker().wake()).kind, "completed");
      const recoveredRuntime = await mcp(context);
      const catalog = recoveredRuntime.composite.definitions();
      const recovered = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        crashAfterResolved: true,
        toolRuntime: recoveredRuntime.composite,
        toolName: "mcp__fixture__echo",
        toolInput: '{"value":"hello"}',
        afterToolProviderResolved: async () => {
          for (let i = 0; i < 10; i++)
            await recoveredRuntime.group.refresh(new AbortController().signal);
        },
      });
      const interrupted = await recovered.worker().wake();
      assert.equal(interrupted.kind, "retried", JSON.stringify(interrupted));
      const run = await recovered.run();
      assert.ok(run !== null);
      const retained = () =>
        recoveredRuntime.composite.retainedExecutionResults({
          runId: run.runId,
          limit: 128,
        });
      assert.equal(retained().length, 1);
      assert.equal((await recovered.receipts())[0]?.status, "dispatched");
      assert.equal(recovered.requests.length, 1);
      assert.deepEqual(recoveredRuntime.composite.definitions(), catalog);
      await recovered.reopen();
      const result = await recovered.worker().wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      assert.equal(retained().length, 0);
      const receipt = (await recovered.receipts())[0];
      assert.equal(receipt?.status, "completed");
      assert.match(receipt?.result?.output ?? "", /"invocations":1/u);
      assert.deepEqual(receipt?.result, (await normal.receipts())[0]?.result);
      assert.deepEqual(recovered.requests, normal.requests);
      assert.equal(recovered.requests.length, 2);
      assert.equal(recovered.requests[1]?.previous_response_id, "resp-tools");
      assert.deepEqual(recovered.requests[1]?.input, [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: receipt?.result?.output,
        },
      ]);
      const events = await recovered.events();
      assert.equal(
        events.filter((event) => event.type === "tool.completed").length,
        1,
      );
      await recovered.reopen();
      assert.equal((await recovered.worker().wake()).kind, "idle");
      assert.deepEqual(await recovered.events(), events);
    },
  );
}

async function mcp(context: TestContext) {
  const policy: ToolExecutionPolicy = {
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: "mcp-fixture",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "mcp-runtime-fixture" },
    capability: "mcp.tool.read",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      maxArtifactBytes: 1048576,
    },
  };
  const group = new McpRuntimeGroup([
    new McpToolRuntime({
      serverId: "fixture",
      policies: new Map([["echo", policy]]),
      client: new StdioMcpClient({
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL(
              "../../../packages/mcp-runtime/src/fixtures/stdio-server.mjs",
              import.meta.url,
            ),
          ),
        ],
        env: {},
      }),
    }),
  ]);
  context.after(() => group.close());
  await group.connect(new AbortController().signal);
  return { group, composite: new CompositeToolRuntime([group]) };
}
