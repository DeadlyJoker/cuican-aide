import assert from "node:assert/strict";
import test from "node:test";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";
import { startBrowserExecutionTransport } from "../../crewon-ui/electron/browserExecutionTransport.ts";
import { BrowserExecutionToolRuntime } from "./browser-execution-tool-runtime.ts";
import {
  createFixture,
  responseEvents,
} from "./runtime-tool-continuation.test-support.ts";

for (const crashAfterResolved of [false, true]) {
  test(`C05 real Worker feeds malformed observe back to the scripted model and completes after correction (crash=${crashAfterResolved})`, async (context) => {
    context.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2026-08-08T01:00:00Z"),
    });
    const dispatched: ToolExecutionCommand[] = [];
    const resolutions: ToolExecutionResolution[] = [];
    const bridge = await startBrowserExecutionTransport({
      async execute(command) {
        dispatched.push(command);
        assert.equal(command.name, "crewon_browser_observe");
        assert.equal(command.input, "{}");
        return {
          status: "completed",
          executionId: command.executionId,
          providerReceiptId: "corrected-observation-receipt",
          result: {
            schemaVersion: "crewon.tool-result.v0",
            callId: command.callId,
            output:
              '{"sessionId":"authorized-session","generation":0,"observationId":"observation-1","targets":[]}',
            isError: false,
            artifactRef: null,
          },
        };
      },
      async reconcile() {
        throw new Error("malformed input must settle locally");
      },
      async cancel() {
        throw new Error("no browser action needs cancellation");
      },
      async download() {
        throw new Error("observe cannot download");
      },
    });
    context.after(() => bridge.close());
    const fixture = await createFixture(context, {
      backend: "sqlite",
      storeResponses: true,
      crashAfterCommit: false,
      crashAfterResolved,
      toolRuntimeFactory: () => new BrowserExecutionToolRuntime(bridge),
      afterToolProviderResolved: async (resolution) => {
        resolutions.push(resolution);
      },
      modelResponseEvents: (requestNumber) => {
        if (requestNumber === 1)
          return responseEvents(
            true,
            1,
            "crewon_browser_observe",
            '{"sessionId":""}',
          );
        if (requestNumber === 2)
          return JSON.parse(
            JSON.stringify(
              responseEvents(true, 1, "crewon_browser_observe", "{}"),
            )
              .replaceAll("call-1", "corrected-call-1")
              .replaceAll("resp-tools", "resp-corrected"),
          );
        return responseEvents(false);
      },
    });
    if (crashAfterResolved) {
      assert.equal((await fixture.worker().wake()).kind, "retried");
      assert.equal(dispatched.length, 0);
      assert.equal(resolutions[0]?.status, "completed");
      assert.equal((await fixture.receipts())[0]?.status, "dispatched");
      await fixture.reopen();
      await fixture.makeDue();
    }
    const finished = await fixture.worker().wake();
    assert.equal(
      finished.kind,
      "completed",
      JSON.stringify({ finished, events: await fixture.events() }),
    );
    assert.equal((await fixture.run())?.status, "completed");
    assert.equal(
      dispatched.length,
      1,
      "only the corrected input reaches the browser",
    );
    assert.equal(fixture.requests.length, 3);
    const completed = (await fixture.events()).filter(
      (event) => event.type === "tool.completed",
    );
    assert.equal(completed.length, 2);
    assert.equal(completed[0]!.data.isError, true);
    assert.equal(
      JSON.parse(completed[0]!.data.output).code,
      "browser_execution_input_invalid",
    );
    assert.match(
      JSON.parse(completed[0]!.data.output).message,
      /Omit sessionId.*empty/u,
    );
    assert.equal(completed[1]!.data.isError, false);
    for (const [index, callId, responseId] of [
      [1, "call-1", "resp-tools"],
      [2, "corrected-call-1", "resp-corrected"],
    ] as const) {
      const output = completed[index - 1]!.data.output;
      assert.ok(Buffer.byteLength(output) <= 9216);
      assert.equal(fixture.requests[index]?.previous_response_id, responseId);
      assert.deepEqual(fixture.requests[index]?.input, [
        { type: "function_call_output", call_id: callId, output },
      ]);
    }
    assert.deepEqual(
      (await fixture.receipts()).map((receipt) => receipt?.status),
      ["completed", "completed"],
    );
    assert.equal((await fixture.worker().wake()).kind, "idle");
    if (crashAfterResolved) assert.deepEqual(resolutions[0], resolutions[1]);
  });
}
