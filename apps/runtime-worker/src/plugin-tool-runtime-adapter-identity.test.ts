import assert from "node:assert/strict";
import test from "node:test";
import {
  adapt,
  command,
  context,
  rawRuntime,
  result,
} from "./plugin-tool-runtime-adapter.test-support.ts";
import {
  checkedScopedMetadata,
  snapshotContext,
} from "./plugins/plugin-tool-runtime-adapter-data.ts";

test("legacy Run IDs execute without rewriting and a different historical Run stays outside the original binding", async () => {
  for (const first of ["-", "_"]) {
    const runId = `${first}${"A".repeat(42)}`;
    const original = context();
    const calls: string[] = [];
    const port = adapt(
      rawRuntime({
        execute: async (execution) => {
          calls.push(execution.runId);
          return result(execution);
        },
      }),
      {
        context: { ...original, run: { ...original.run, runId } },
        authorize: async ({ command: execution }) => {
          calls.push(execution.runId);
        },
      },
    );
    const signal = new AbortController().signal;
    await assert.rejects(
      port.execute(command({ runId: `${first}${"B".repeat(42)}` }), signal),
      /plugin_tool_scope_mismatch/u,
    );
    assert.deepEqual(calls, []);
    const completed = await port.execute(command({ runId }), signal);
    assert.equal(completed.status, "completed");
    assert.deepEqual(calls, [runId, runId]);
  }
});

test("immutable historical 32-byte base64url Run IDs preserve their exact source and retained-result ownership", () => {
  for (const first of ["-", "_"]) {
    const runId = `${first}${"A".repeat(42)}`;
    const original = context();
    const input = {
      ...original,
      run: {
        ...original.run,
        runId,
        source: {
          runId,
          operationId: "operation-1",
          bindingDigest: original.run.bindingDigest,
        },
      },
    };
    const captured = snapshotContext(input);
    assert.equal(captured.run.runId, runId);
    assert.equal(captured.run.source!.runId, runId);
    const metadata = {
      tenantId: input.scope.tenantId,
      runId,
      executionId: "execution-1",
      idempotencyKey: "original-task-key",
      actionDigest: input.run.bindingDigest,
      kind: "function",
      name: "tool",
    };
    assert.equal(checkedScopedMetadata(metadata).runId, runId);
    assert.throws(
      () => checkedScopedMetadata({ ...metadata, tenantId: runId }),
      /plugin_tool_identity_invalid/u,
    );
  }
});

test("historical Run compatibility rejects other leading characters, lengths, and non-base64url characters", () => {
  for (const runId of [
    "-",
    "_",
    `-${"A".repeat(41)}`,
    `_${"A".repeat(43)}`,
    `~${"A".repeat(42)}`,
    `-${"A".repeat(41)}.`,
    `_${"A".repeat(41)}/`,
    `-${"A".repeat(42)}\n`,
    `_${"A".repeat(42)}\r`,
    `-${"A".repeat(42)}\r\n`,
  ]) {
    for (const field of ["run", "source"] as const) {
      const original = context();
      const input = {
        ...original,
        run: {
          ...original.run,
          ...(field === "run" ? { runId } : {}),
          source:
            field === "source"
              ? {
                  runId,
                  operationId: "operation-1",
                  bindingDigest: original.run.bindingDigest,
                }
              : null,
        },
      };
      assert.throws(
        () => snapshotContext(input),
        /plugin_tool_identity_invalid/u,
      );
    }
  }
});

test("historical Run IDs do not widen scope, Thread, operation or credential identity boundaries", () => {
  const historicalId = `_${"A".repeat(42)}`;
  for (const field of [
    "tenant",
    "thread",
    "operation",
    "credential",
  ] as const) {
    const original = context();
    const input = {
      ...original,
      ...(field === "tenant"
        ? { scope: { ...original.scope, tenantId: historicalId } }
        : {}),
      ...(field === "thread"
        ? { run: { ...original.run, threadId: historicalId } }
        : {}),
      ...(field === "operation"
        ? {
            run: {
              ...original.run,
              source: {
                runId: "source-run-1",
                operationId: historicalId,
                bindingDigest: original.run.bindingDigest,
              },
            },
          }
        : {}),
      ...(field === "credential"
        ? {
            configuration: {
              ...original.configuration,
              credentialBindings: [
                { slotId: "service", credentialBindingId: historicalId },
              ],
            },
          }
        : {}),
    };
    assert.throws(
      () => snapshotContext(input),
      /plugin_tool_identity_invalid/u,
    );
  }
});
