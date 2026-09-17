import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpRuntimeGroup,
  McpToolRuntime,
  StdioMcpClient,
} from "@crewon/mcp-runtime";
import { InMemoryToolBroker, type ToolDefinition } from "@crewon/tool-broker";
import {
  executionCommand,
  readOnlyPolicy,
} from "../../../packages/mcp-runtime/src/mcp-tool-runtime.test-support.ts";
import { committedResult } from "../../../packages/tool-broker/src/tool-execution.test-support.ts";
import { retirementFixture } from "./idle-agent-runtime-retirement.test-support.ts";

test(
  "version churn automatically closes an acknowledged MCP process and reconstructs a new one on demand",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "crewon-owned-mcp-retirement-"));
    const definitions: readonly ToolDefinition[] = [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "mcp__fixture__echo",
        description: "MCP tool",
        execution: "parallel",
        inputSchema: { type: "object" },
      },
    ];
    const pids: number[] = [];
    const f = await retirementFixture({
      count: 100,
      definitions,
      tools: async (id) => {
        if (id !== "v-0") return new InMemoryToolBroker(definitions);
        const pidFile = join(root, `pid-${pids.length}`);
        const runtime = new McpRuntimeGroup([
          new McpToolRuntime({
            serverId: "fixture",
            policies: new Map([["echo", readOnlyPolicy()]]),
            client: new StdioMcpClient({
              command: process.execPath,
              args: [
                fileURLToPath(
                  new URL(
                    "../../../packages/mcp-runtime/src/fixtures/retirement-server.mjs",
                    import.meta.url,
                  ),
                ),
                pidFile,
              ],
            }),
          }),
        ]);
        try {
          await runtime.connect(new AbortController().signal);
          pids.push(Number(await readFile(pidFile, "utf8")));
          return runtime;
        } catch (error) {
          await runtime.close();
          throw error;
        }
      },
    });
    t.after(async () => {
      await f.close();
      await rm(root, { recursive: true, force: true });
    });
    const lease = await f.acquire(0),
      first = lease.resource;
    const command = executionCommand();
    const result = await first.toolRuntime
      .execute(command, new AbortController().signal)
      .finally(lease.release);
    for (let n = 1; n < 100; n++) (await f.acquire(n)).release();
    await f.drain();
    assert.equal(f.closed.includes("v-0"), false);
    assert.doesNotThrow(() => process.kill(pids[0]!, 0));
    first.toolRuntime.acknowledgeExecutionResult!(
      committedResult(command, result.providerReceiptId),
    );
    for (let n = 1; n < 100; n++) (await f.acquire(n)).release();
    await f.drain();
    assert.equal(f.closed.filter((id) => id === "v-0").length, 1);
    assert.throws(() => process.kill(pids[0]!, 0), { code: "ESRCH" });
    const restored = await f.acquire(0);
    try {
      assert.notEqual(restored.resource, first);
      assert.deepEqual(restored.resource.version, first.version);
      assert.deepEqual(
        restored.resource.toolRuntime.definitions(),
        definitions,
      );
      assert.equal(pids.length, 2);
      assert.notEqual(pids[0], pids[1]);
      assert.doesNotThrow(() => process.kill(pids[1]!, 0));
    } finally {
      restored.release();
    }
    await f.close();
    assert.throws(() => process.kill(pids[1]!, 0), { code: "ESRCH" });
  },
);
