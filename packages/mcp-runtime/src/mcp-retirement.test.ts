import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { McpClientPort } from "./mcp-client-port.ts";
import { McpToolRuntime } from "./mcp-tool-runtime.ts";
import { McpRuntimeGroup } from "./mcp-runtime-group.ts";
import { StdioMcpClient } from "./stdio-mcp-client.ts";
import {
  executionCommand,
  mutationPolicy,
  readOnlyPolicy,
} from "./mcp-tool-runtime.test-support.ts";

const signal = () => new AbortController().signal;
const page = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
const client = (extra: Partial<McpClientPort> = {}): McpClientPort => ({
  connect: async () => {},
  listTools: async () => page,
  callTool: async () => ({ content: [] }),
  close: async () => {},
  ...extra,
});

test("aborted catalog wait keeps MCP ownership until the physical operation settles", async (t) => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let refreshing = false;
  const runtime = new McpToolRuntime({
    serverId: "fixture",
    policies: new Map([["echo", readOnlyPolicy()]]),
    client: client({
      listTools: async () => {
        if (refreshing) {
          entered();
          await held;
        }
        return page;
      },
    }),
  });
  const group = new McpRuntimeGroup([runtime]);
  t.after(async () => {
    finish();
    await group.close();
  });
  await group.connect(signal());
  assert.equal(group.canRetire(), true);
  refreshing = true;
  const caller = new AbortController();
  const pending = group.refresh(caller.signal);
  await started;
  const rejected = assert.rejects(pending, /stop/);
  caller.abort(new Error("stop"));
  await rejected;
  assert.equal(group.canRetire(), false);
  assert.equal(runtime.canRetire(), false);
  finish();
  await nextTurn();
  assert.equal(group.canRetire(), true);
});

test("an empty MCP scan is not a retirement proof for an externally owned mutation provider", async (t) => {
  const runtime = new McpToolRuntime({
    serverId: "fixture",
    policies: new Map([["echo", mutationPolicy()]]),
    client: client({
      mutationProvider: {
        execute: async () => ({
          status: "unknownOutcome",
          providerReceiptId: null,
        }),
        reconcile: async () => ({
          status: "unknownOutcome",
          providerReceiptId: null,
        }),
        cancel: async () => ({
          status: "unknownOutcome",
          providerReceiptId: null,
        }),
      },
    }),
  });
  t.after(() => runtime.close());
  await runtime.connect(signal());
  assert.deepEqual(runtime.scanRetainedExecutionResults({ limit: 1 }), []);
  assert.equal(runtime.canRetire(), false);
});

test(
  "real stdio MCP remains owned through reservation and result ACK, and close terminates its process",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "crewon-mcp-retirement-"));
    const pidFile = join(root, "pid");
    const runtime = new McpToolRuntime({
      serverId: "fixture",
      policies: new Map([["echo", readOnlyPolicy()]]),
      client: new StdioMcpClient({
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL("./fixtures/retirement-server.mjs", import.meta.url),
          ),
          pidFile,
        ],
      }),
    });
    const group = new McpRuntimeGroup([runtime]);
    t.after(async () => {
      await group.close();
      await rm(root, { recursive: true, force: true });
    });
    await group.connect(signal());
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0));
    const command = executionCommand();
    const reservation = group.reserveExecution(command, signal())!;
    assert.equal(group.canRetire(), false);
    assert.deepEqual(group.scanRetainedExecutionResults({ limit: 1 }), []);
    const result = await reservation.execute();
    assert.equal(result.status, "completed");
    assert.equal(group.canRetire(), false);
    assert.deepEqual(group.scanRetainedExecutionResults({ limit: 1 }), []);
    group.acknowledgeExecutionResult({
      idempotencyKey: command.idempotencyKey,
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      actionIntent: command.actionIntent,
      status: "completed",
      providerReceiptId: result.providerReceiptId,
    });
    assert.equal(group.canRetire(), true);
    await group.close();
    assert.equal(group.canRetire(), false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
