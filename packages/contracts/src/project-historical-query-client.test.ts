import assert from "node:assert/strict";
import test from "node:test";
import { createPluginProjectHistoricalQueryClient } from "./project-historical-query-ui-client.ts";
import { parseProjectHistoricalQueryHostContext } from "./project-historical-query-host-context-contract.ts";
import {
  parseProjectHistoricalQueryUiActionRequest,
  parseProjectHistoricalQueryUiActionResponse,
} from "./project-historical-query-ui-action-contract.ts";
import type { ProjectHistoricalQueryAbortSignal } from "./plugin-project-historical-queries-service.ts";
const input = {
  reference: { projectId: "project", assetId: "asset", assetRevision: 1 },
  operationId: "4263a1da-d6fe-eac4-aaec-f05a1e4f7485",
  threadId: "thread",
  expectedThreadRevision: 1,
  idempotencyKey: "original-query",
};
const receipt = {
  disposition: "committed",
  threadId: "thread",
  threadRevision: 2,
  runId: "query-run",
  messageId: "query-message",
  configurationRevision: 1,
};
const codec = {
  parseRequest: parseProjectHistoricalQueryUiActionRequest,
  parseResponse: parseProjectHistoricalQueryUiActionResponse,
};
test("captured public client invokes only the independently named query and validates the original receipt", async () => {
  const calls: unknown[] = [];
  const services = {
    async invoke(...args: unknown[]) {
      calls.push(args);
      return receipt;
    },
  };
  const client = createPluginProjectHistoricalQueryClient(services, codec);
  assert.equal(Object.isFrozen(client), true);
  services.invoke = async () => {
    throw new Error("replacement_must_not_execute");
  };
  assert.deepEqual(await client.queryConceptGeneration(input), receipt);
  assert.deepEqual(calls, [
    ["crewon.project-historical-queries.v1.queryConceptGeneration", input, {}],
  ]);
  const bad = createPluginProjectHistoricalQueryClient(
    {
      async invoke() {
        return { ...receipt, threadRevision: 3 };
      },
    },
    codec,
  );
  await assert.rejects(bad.queryConceptGeneration(input));
});
test("client rejects accessors, caller-selected targets and cancellation before mounted IO", async () => {
  let reads = 0,
    calls = 0;
  const client = createPluginProjectHistoricalQueryClient(
    {
      async invoke() {
        calls++;
        return receipt;
      },
    },
    codec,
  );
  const options = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      reads++;
      return undefined;
    },
  });
  await assert.rejects(client.queryConceptGeneration(input, options));
  await assert.rejects(
    client.queryConceptGeneration({ ...input, target: "other" } as never),
  );
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    client.queryConceptGeneration(input, { signal: cancellation.signal }),
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  const getter = Object.defineProperty({}, "invoke", {
    get() {
      reads++;
      return () => receipt;
    },
  });
  assert.throws(() =>
    createPluginProjectHistoricalQueryClient(getter as never, codec),
  );
  assert.equal(reads, 0);
});
test("portable declaration compatibility does not permit a structural signal to execute mounted IO", async () => {
  let reads = 0,
    calls = 0;
  const structural: ProjectHistoricalQueryAbortSignal = {
    aborted: false,
    reason: undefined,
    throwIfAborted() {
      reads++;
    },
    addEventListener() {
      reads++;
    },
    removeEventListener() {
      reads++;
    },
  };
  const client = createPluginProjectHistoricalQueryClient(
    {
      async invoke() {
        calls++;
        return receipt;
      },
    },
    codec,
  );
  await assert.rejects(
    client.queryConceptGeneration(input, { signal: structural }),
    { message: "plugin_project_historical_query_client_invalid" },
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});
test("native cancellation reaches mounted IO unchanged and rejects its original reason", async () => {
  const controller = new AbortController();
  const reason = new Error("mounted_query_cancelled");
  let calls = 0,
    responses = 0;
  const client = createPluginProjectHistoricalQueryClient(
    {
      async invoke(_action, _input, options) {
        calls++;
        assert.equal(options?.signal, controller.signal);
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    },
    {
      ...codec,
      parseResponse(request, output) {
        responses++;
        return codec.parseResponse(request, output);
      },
    },
  );
  const pending = client.queryConceptGeneration(input, {
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 1);
  assert.equal(responses, 0);
});
test("native cancellation after IO prevents receipt parsing and preserves the abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("query_cancelled_after_io");
  let calls = 0,
    responses = 0;
  const client = createPluginProjectHistoricalQueryClient(
    {
      async invoke(_action, _input, options) {
        calls++;
        assert.equal(options?.signal, controller.signal);
        controller.abort(reason);
        return receipt;
      },
    },
    {
      ...codec,
      parseResponse(request, output) {
        responses++;
        return codec.parseResponse(request, output);
      },
    },
  );
  await assert.rejects(
    client.queryConceptGeneration(input, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 1);
  assert.equal(responses, 0);
});
test("historical context is explicitly session-only and cannot adopt an old namespace or pretend uncertainty is ready", () => {
  const context = {
    version: "crewon.project-historical-query-host-context.v1",
    recovery: "session-only",
    phase: "ready",
    thread: { threadId: "thread", revision: 1, provisional: false },
    threadReady: true,
    intent: null,
  };
  assert.deepEqual(parseProjectHistoricalQueryHostContext(context), context);
  for (const patch of [
    { version: "crewon.project-generation-query-host-context.v1" },
    { recovery: "durable" },
    { thread: null },
    { phase: "uncertain" },
    { authority: true },
  ])
    assert.throws(() =>
      parseProjectHistoricalQueryHostContext({ ...context, ...patch }),
    );
  const uncertain = {
    ...context,
    phase: "uncertain",
    threadReady: false,
    intent: {
      request: input,
      phase: "uncertain",
      retryable: true,
      receipt: null,
    },
  };
  assert.deepEqual(
    parseProjectHistoricalQueryHostContext(uncertain),
    uncertain,
  );
  assert.throws(() =>
    parseProjectHistoricalQueryHostContext({ ...uncertain, threadReady: true }),
  );
  assert.throws(() =>
    parseProjectHistoricalQueryHostContext({
      ...uncertain,
      intent: { ...uncertain.intent, receipt },
    }),
  );
  const accepted = {
    ...context,
    intent: { request: input, phase: "accepted", retryable: false, receipt },
  };
  assert.deepEqual(parseProjectHistoricalQueryHostContext(accepted), accepted);
});
