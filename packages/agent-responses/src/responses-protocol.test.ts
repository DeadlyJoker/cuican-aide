import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ModelTransportError } from "@crewon/agent-kernel";

import { ResponsesProtocolDecoder } from "./responses-protocol.ts";

type Fixture = Readonly<{
  caseId: string;
  cases: readonly Readonly<{
    name: string;
    created: Readonly<Record<string, unknown>>;
    terminal: Readonly<Record<string, unknown>>;
  }>[];
  expected: Readonly<{
    terminal: boolean;
    usageEvents: number;
    completionEvents: number;
    errorCategory: null;
    retryable: null;
  }>;
}>;

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-completed-without-usage.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Fixture;

type CompletedWithoutOutputFixture = Readonly<{
  caseId: string;
  events: readonly Readonly<Record<string, unknown>>[];
  expected: Readonly<{
    terminal: boolean;
    responseId: string;
    stableEvents: readonly string[];
    output: string;
    completedItem: Readonly<{
      type: "message";
      role: "assistant";
      content: string;
    }>;
    usage: Readonly<{
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>;
    errorCategory: null;
    retryable: null;
  }>;
}>;

const completedWithoutOutputFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-completed-without-output.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as CompletedWithoutOutputFixture;

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${fixture.caseId}: ${sequencePolicy} transport framing`, () => {
    for (const fixtureCase of fixture.cases) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy,
        completedCheckpoint: () => null,
      });
      const events = [
        ...decoder.accept(fixtureCase.created),
        ...decoder.accept(fixtureCase.terminal),
      ];
      decoder.finish();

      assert.deepEqual(
        {
          terminal: decoder.terminal,
          usageEvents: events.filter((event) => event.type === "usage").length,
          completionEvents: events.filter((event) => event.type === "completed")
            .length,
          errorCategory: null,
          retryable: null,
        },
        fixture.expected,
        fixtureCase.name,
      );
    }
  });
}

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${completedWithoutOutputFixture.caseId}: ${sequencePolicy} shared decoder`, () => {
    const decoder = new ResponsesProtocolDecoder({
      sequencePolicy,
      completedCheckpoint: (responseId) => ({
        schemaVersion: "crewon.provider-checkpoint.v0",
        adapterName: "direct-responses",
        adapterVersion: "2",
        modelId: "provider-model",
        opaquePayload: { responseId },
      }),
    });
    const events = completedWithoutOutputFixture.events.flatMap((event) =>
      decoder.accept(event),
    );
    decoder.finish();
    const usage = events.find((event) => event.type === "usage");

    assert.deepEqual(
      {
        terminal: decoder.terminal,
        responseId: decoder.completedResponseId,
        stableEvents: events.map((event) => event.type),
        output: events
          .filter((event) => event.type === "output.delta")
          .map((event) => event.delta)
          .join(""),
        completedItem: events.find(
          (event) => event.type === "output.item.completed",
        )?.item,
        usage:
          usage?.type === "usage"
            ? {
                inputTokens: usage.inputTokens,
                cachedInputTokens: usage.cachedInputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
              }
            : null,
        errorCategory: null,
        retryable: null,
      },
      completedWithoutOutputFixture.expected,
    );
  });
}

test(`${completedWithoutOutputFixture.caseId}: present final output remains strict`, () => {
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  const terminalIndex = completedWithoutOutputFixture.events.length - 1;
  for (const event of completedWithoutOutputFixture.events.slice(
    0,
    terminalIndex,
  )) {
    decoder.accept(event);
  }
  const terminal = completedWithoutOutputFixture.events[terminalIndex];
  assert.ok(terminal !== undefined);
  assert.throws(
    () =>
      decoder.accept({
        ...terminal,
        response: {
          ...(terminal.response as Readonly<Record<string, unknown>>),
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "different answer" }],
            },
          ],
        },
      }),
    (error: unknown) =>
      error instanceof ModelTransportError &&
      error.code === "responses_output_mismatch",
  );
});
