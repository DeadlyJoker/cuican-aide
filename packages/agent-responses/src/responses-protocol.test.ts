import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ModelTransportError,
  type ModelInputItem,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";

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

type TerminalWithoutCreatedFixture = Readonly<{
  caseId: string;
  cases: ReadonlyArray<
    Readonly<{
      name: "failed" | "incomplete";
      terminal: Readonly<Record<string, unknown>>;
      expected: Readonly<{
        stableEvents: readonly string[];
        partialOutput: string;
        completedHistory: readonly ModelInputItem[];
        terminal: "failed";
        usage: null;
        errorCategory: "provider" | "incomplete";
        retryable: boolean;
        responseId: null;
      }>;
    }>
  >;
}>;

const terminalWithoutCreatedFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-terminal-without-created.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as TerminalWithoutCreatedFixture;

type CreatedWithoutIdFixture = Readonly<{
  caseId: string;
  cases: ReadonlyArray<
    Readonly<{
      name: "completed" | "failed" | "incomplete";
      events: readonly Readonly<Record<string, unknown>>[];
      expected: Readonly<{
        stableEvents: readonly string[];
        terminal: "completed" | "failed";
        errorCategory: "provider" | "incomplete" | null;
        retryable: boolean | null;
        checkpoint: null;
      }>;
    }>
  >;
}>;

const createdWithoutIdFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-created-without-id.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as CreatedWithoutIdFixture;

type PostTerminalFixture = Readonly<{
  caseId: string;
  cases: ReadonlyArray<
    Readonly<{
      name: string;
      events: readonly Readonly<Record<string, unknown>>[];
      expected: Readonly<{
        stableEvents: readonly string[];
        output: string;
        terminal: "failed";
        errorCategory: "provider" | "incomplete";
        retryable: boolean;
      }>;
    }>
  >;
}>;

type TopLevelErrorFixture = Readonly<{
  caseId: string;
  cases: ReadonlyArray<
    Readonly<{
      name: string;
      events: readonly Readonly<Record<string, unknown>>[];
      expected: Readonly<{
        stableEvents: readonly string[];
        terminal: "failed";
        errorCategory: "provider";
        retryable: boolean;
        partialOutput: string;
        completedHistory: readonly ModelInputItem[];
        usage: null;
        responseId: null;
      }>;
    }>
  >;
}>;

type TopLevelErrorPayloadFixture = Readonly<{
  caseId: string;
  fatalProviderCodes: readonly string[];
  cases: ReadonlyArray<
    Readonly<{
      name: string;
      events: readonly Readonly<Record<string, unknown>>[];
      expected: Readonly<{
        stableEvents: readonly string[];
        terminal: "failed";
        errorCategory: "provider";
        code: string;
        retryable: boolean;
        durableRetryProjection: Readonly<{
          sampling: "retry" | "fail";
          afterBudgetExhausted: "fail";
        }>;
        partialOutput: string;
        completedHistory: readonly ModelInputItem[];
        usage: null;
        checkpoint: null;
      }>;
    }>
  >;
}>;

type GenericTerminalFixture = Readonly<{
  caseId: string;
  cases: ReadonlyArray<
    Readonly<{
      name: string;
      events: readonly Readonly<Record<string, unknown>>[];
      expected: Readonly<{
        stableEvents: readonly string[];
        terminal: "failed";
        errorCategory: "provider" | "incomplete";
        code: string;
        retryable: true;
        durableRetryProjection: Readonly<{
          sampling: "retry";
          afterBudgetExhausted: "fail";
        }>;
        partialOutput: string;
        completedHistory: readonly ModelInputItem[];
        usage: null;
        responseId: string | null;
      }>;
    }>
  >;
}>;

type UnknownEventFixture = Readonly<{
  caseId: string;
  events: readonly Readonly<Record<string, unknown>>[];
  expected: Readonly<{
    stableEvents: readonly string[];
    terminal: "completed";
    output: string;
    completedHistory: readonly ModelInputItem[];
    usage: Readonly<Record<string, unknown>>;
    responseId: string;
  }>;
}>;

const postTerminalFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-post-terminal.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as PostTerminalFixture;

const topLevelErrorFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-top-level-error.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as TopLevelErrorFixture;

const topLevelErrorPayloadFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-top-level-error-payload.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as TopLevelErrorPayloadFixture;

const unknownEventFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-unknown-event.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as UnknownEventFixture;

const reasoningFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-reasoning.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  caseId: string;
  events: readonly Readonly<Record<string, unknown>>[];
  expected: Readonly<{
    transportEvents: readonly ModelTransportEvent[];
    completedHistory: readonly ModelInputItem[];
  }>;
}>;

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${unknownEventFixture.caseId}: ${sequencePolicy} ignores unknown non-terminal events`, () => {
    const decoder = new ResponsesProtocolDecoder({
      sequencePolicy,
      completedCheckpoint: () => null,
    });
    const events = unknownEventFixture.events.flatMap((event) =>
      decoder.accept(event),
    );
    decoder.finish();
    const usage = events.find((event) => event.type === "usage");
    assert.deepEqual(
      {
        stableEvents: events.map((event) => event.type),
        terminal: events.at(-1)?.type ?? null,
        output: events
          .filter((event) => event.type === "output.delta")
          .map((event) => event.delta)
          .join(""),
        completedHistory: decoder.completedHistoryItems,
        usage:
          usage?.type === "usage"
            ? {
                inputTokens: usage.inputTokens,
                cachedInputTokens: usage.cachedInputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
              }
            : null,
        responseId: decoder.completedResponseId,
      },
      unknownEventFixture.expected,
    );
  });
}

test(`${unknownEventFixture.caseId}: framing and fail-closed boundaries remain strict`, () => {
  const withoutFirstSequence = unknownEventFixture.events.map((event, index) =>
    index === 0
      ? Object.fromEntries(
          Object.entries(event).filter(([key]) => key !== "sequence_number"),
        )
      : event,
  );
  const websocketDecoder = new ResponsesProtocolDecoder({
    sequencePolicy: "whenPresent",
    completedCheckpoint: () => null,
  });
  assert.doesNotThrow(() => {
    for (const event of withoutFirstSequence) websocketDecoder.accept(event);
    websocketDecoder.finish();
  });

  const httpDecoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  assert.throws(
    () => httpDecoder.accept(withoutFirstSequence[0]),
    (error) =>
      error instanceof ModelTransportError &&
      error.code === "responses_sequence_invalid",
  );

  const malformedKnownDecoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  malformedKnownDecoder.accept(unknownEventFixture.events[1]);
  assert.throws(
    () =>
      malformedKnownDecoder.accept({
        type: "response.output_text.delta",
        sequence_number: 2,
      }),
    (error) =>
      error instanceof ModelTransportError &&
      error.code === "responses_delta_invalid",
  );

  const terminalDecoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  for (const event of unknownEventFixture.events) terminalDecoder.accept(event);
  assert.throws(
    () =>
      terminalDecoder.accept({
        type: "response.provider_future_notice",
        sequence_number: 5,
      }),
    (error) =>
      error instanceof ModelTransportError &&
      error.code === "responses_event_after_terminal",
  );
});

test("ignores blank output deltas emitted by compatible Responses gateways", () => {
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  decoder.accept({
    type: "response.created",
    sequence_number: 0,
    response: { id: "response-1" },
  });

  assert.deepEqual(
    decoder.accept({
      type: "response.output_text.delta",
      sequence_number: 1,
      delta: "",
    }),
    [],
  );
  assert.deepEqual(
    decoder.accept({
      type: "response.output_text.delta",
      sequence_number: 2,
      delta: "\n",
    }),
    [],
  );
  assert.deepEqual(
    decoder.accept({
      type: "response.output_text.delta",
      sequence_number: 3,
      delta: "done",
    }),
    [{ type: "output.delta", delta: "\ndone" }],
  );
});

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${reasoningFixture.caseId}: ${sequencePolicy} preserves ordered bounded projection without history pollution`, () => {
    const decoder = new ResponsesProtocolDecoder({
      sequencePolicy,
      completedCheckpoint: () => null,
    });
    const events = reasoningFixture.events.flatMap((event) =>
      decoder.accept(
        sequencePolicy === "whenPresent"
          ? Object.fromEntries(
              Object.entries(event).filter(
                ([key]) => key !== "sequence_number",
              ),
            )
          : event,
      ),
    );
    decoder.finish();
    assert.deepEqual(events, reasoningFixture.expected.transportEvents);
    assert.deepEqual(
      decoder.completedHistoryItems,
      reasoningFixture.expected.completedHistory,
    );
  });
}

test(`${reasoningFixture.caseId}: malformed, over-budget, and post-terminal reasoning fail closed`, () => {
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  decoder.accept(reasoningFixture.events[0]);
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    assert.deepEqual(
      decoder.accept({
        type: "response.reasoning_text.delta",
        sequence_number: sequence,
        content_index: 0,
        delta: "x".repeat(16 * 1024),
      }),
      [
        {
          type: "reasoning.delta",
          channel: "content",
          index: 0,
          delta: "x".repeat(16 * 1024),
        },
      ],
    );
  }
  assert.throws(
    () =>
      decoder.accept({
        type: "response.reasoning_text.delta",
        sequence_number: 5,
        content_index: 0,
        delta: "x",
      }),
    (error) =>
      error instanceof ModelTransportError &&
      error.code === "responses_reasoning_budget_exceeded",
  );

  const terminalDecoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  for (const event of reasoningFixture.events) terminalDecoder.accept(event);
  assert.throws(
    () =>
      terminalDecoder.accept({
        type: "response.reasoning_summary_text.delta",
        sequence_number: 9,
        summary_index: 2,
        delta: "late",
      }),
    (error) =>
      error instanceof ModelTransportError &&
      error.code === "responses_event_after_terminal",
  );

  const framingDecoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  framingDecoder.accept(reasoningFixture.events[0]);
  assert.deepEqual(
    framingDecoder.accept({
      type: "response.output_item.added",
      sequence_number: 1,
      item: { type: "message", role: "assistant", content: [] },
    }),
    [],
  );
  assert.deepEqual(
    framingDecoder.accept({
      type: "response.custom_tool_call_input.delta",
      sequence_number: 2,
      delta: "{}",
      item_id: "item-1",
    }),
    [],
  );
});

test(`${topLevelErrorPayloadFixture.caseId}: fatal denylist is explicit and stable`, () => {
  assert.deepEqual(topLevelErrorPayloadFixture.fatalProviderCodes, [
    "context_length_exceeded",
    "insufficient_quota",
    "usage_not_included",
    "invalid_prompt",
    "cyber_policy",
    "server_is_overloaded",
    "slow_down",
  ]);
  for (const providerCode of topLevelErrorPayloadFixture.fatalProviderCodes) {
    const decoder = new ResponsesProtocolDecoder({
      sequencePolicy: "required",
      completedCheckpoint: () => null,
    });
    assert.deepEqual(
      decoder.accept({
        type: "error",
        sequence_number: 0,
        error: { code: providerCode, message: "sensitive provider copy" },
      }),
      [
        {
          type: "failed",
          code: `responses_provider_${providerCode}`,
          retryable: false,
        },
      ],
    );
  }
});

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${topLevelErrorPayloadFixture.caseId}: ${sequencePolicy} malformed and future payloads`, () => {
    for (const fixtureCase of topLevelErrorPayloadFixture.cases) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy,
        completedCheckpoint: () => null,
      });
      const events = [];
      for (const event of fixtureCase.events) {
        events.push(...decoder.accept(event));
        if (decoder.terminal) break;
      }
      decoder.finish();
      const failure = events.find((event) => event.type === "failed");
      assert.deepEqual(
        {
          stableEvents: events.map((event) => event.type),
          terminal: failure?.type ?? null,
          errorCategory: failure?.type === "failed" ? "provider" : null,
          code: failure?.type === "failed" ? failure.code : null,
          retryable: failure?.type === "failed" ? failure.retryable : null,
          durableRetryProjection: {
            sampling:
              failure?.type === "failed" && failure.retryable
                ? "retry"
                : "fail",
            afterBudgetExhausted: "fail",
          },
          partialOutput: events
            .filter((event) => event.type === "output.delta")
            .map((event) => event.delta)
            .join(""),
          completedHistory: decoder.completedHistoryItems,
          usage: events.find((event) => event.type === "usage") ?? null,
          checkpoint: null,
        },
        fixtureCase.expected,
        fixtureCase.name,
      );
    }
  });
}

const genericTerminalFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/responses-generic-terminal.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as GenericTerminalFixture;

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${genericTerminalFixture.caseId}: ${sequencePolicy} generic terminal`, () => {
    for (const fixtureCase of genericTerminalFixture.cases) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy,
        completedCheckpoint: () => null,
      });
      const events = [];
      for (const event of fixtureCase.events) {
        events.push(...decoder.accept(event));
        if (decoder.terminal) break;
      }
      decoder.finish();
      const failure = events.find((event) => event.type === "failed");
      assert.deepEqual(
        {
          stableEvents: events.map((event) => event.type),
          terminal: failure?.type ?? null,
          errorCategory:
            failure?.type === "failed" &&
            failure.code.startsWith("responses_provider_")
              ? "provider"
              : "incomplete",
          code: failure?.type === "failed" ? failure.code : null,
          retryable: failure?.type === "failed" ? failure.retryable : null,
          durableRetryProjection: {
            sampling:
              failure?.type === "failed" && failure.retryable
                ? "retry"
                : "fail",
            afterBudgetExhausted: "fail",
          },
          partialOutput: events
            .filter((event) => event.type === "output.delta")
            .map((event) => event.delta)
            .join(""),
          completedHistory: decoder.completedHistoryItems,
          usage: events.find((event) => event.type === "usage") ?? null,
          checkpoint: null,
        },
        fixtureCase.expected,
        fixtureCase.name,
      );
    }
  });
}

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${topLevelErrorFixture.caseId}: ${sequencePolicy} terminal provider error`, () => {
    for (const fixtureCase of topLevelErrorFixture.cases) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy,
        completedCheckpoint: () => null,
      });
      const events = [];
      for (const event of fixtureCase.events) {
        events.push(...decoder.accept(event));
        if (decoder.terminal) {
          break;
        }
      }
      decoder.finish();
      const failure = events.find((event) => event.type === "failed");

      assert.deepEqual(
        {
          stableEvents: events.map((event) => event.type),
          terminal: failure?.type ?? null,
          errorCategory: failure?.type === "failed" ? "provider" : null,
          retryable: failure?.type === "failed" ? failure.retryable : null,
          partialOutput: events
            .filter((event) => event.type === "output.delta")
            .map((event) => event.delta)
            .join(""),
          completedHistory: decoder.completedHistoryItems,
          usage: events.find((event) => event.type === "usage") ?? null,
          responseId: decoder.completedResponseId,
        },
        fixtureCase.expected,
        fixtureCase.name,
      );
    }
  });
}

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${postTerminalFixture.caseId}: ${sequencePolicy} first failure cutoff`, () => {
    for (const fixtureCase of postTerminalFixture.cases) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy,
        completedCheckpoint: () => null,
      });
      const events = [];
      for (const event of fixtureCase.events) {
        events.push(...decoder.accept(event));
        if (decoder.terminal) {
          break;
        }
      }
      decoder.finish();
      const failure = events.find((event) => event.type === "failed");
      assert.deepEqual(
        {
          stableEvents: events.map((event) => event.type),
          output: events
            .filter((event) => event.type === "output.delta")
            .map((event) => event.delta)
            .join(""),
          terminal: failure?.type ?? null,
          errorCategory:
            failure?.type === "failed" &&
            failure.code.startsWith("responses_provider_")
              ? "provider"
              : "incomplete",
          retryable: failure?.type === "failed" ? failure.retryable : null,
        },
        fixtureCase.expected,
        fixtureCase.name,
      );
      assert.equal(
        decoder.completedResponseId,
        (fixtureCase.events[0]?.response as Readonly<Record<string, unknown>>)
          .id,
        "the first validated identity remains stable after cutoff",
      );
    }
  });
}

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

test(`${completedWithoutOutputFixture.caseId}: portable profile accepts an empty terminal output`, () => {
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "whenPresent",
    finalOutputPolicy: "streamAuthoritativeWhenEmpty",
    completedCheckpoint: () => null,
  });
  const terminalIndex = completedWithoutOutputFixture.events.length - 1;
  const events = completedWithoutOutputFixture.events.slice(0, terminalIndex);
  for (const event of events) {
    decoder.accept(event);
  }
  const terminal = completedWithoutOutputFixture.events[terminalIndex];
  assert.ok(terminal !== undefined);

  assert.doesNotThrow(() =>
    decoder.accept({
      ...terminal,
      response: {
        ...(terminal.response as Readonly<Record<string, unknown>>),
        output: [],
      },
    }),
  );
  assert.equal(decoder.terminal, true);
});

test("completed reasoning items remain observational and out of model history", () => {
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "whenPresent",
    completedCheckpoint: () => null,
  });
  decoder.accept({
    type: "response.created",
    response: { id: "resp-reasoning-item" },
  });

  assert.deepEqual(
    decoder.accept({
      type: "response.output_item.done",
      item: {
        id: "reasoning-item",
        type: "reasoning",
        content: [],
        summary: [],
      },
    }),
    [],
  );
  assert.deepEqual(decoder.completedHistoryItems, []);
});

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${terminalWithoutCreatedFixture.caseId}: ${sequencePolicy} shared decoder`, () => {
    for (const fixtureCase of terminalWithoutCreatedFixture.cases) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy,
        completedCheckpoint: () => null,
      });
      const events = decoder.accept(fixtureCase.terminal);
      decoder.finish();
      const failure = events.find((event) => event.type === "failed");
      const usage = events.find((event) => event.type === "usage");
      const errorCategory =
        failure?.type === "failed" &&
        failure.code.startsWith("responses_provider_")
          ? "provider"
          : failure?.type === "failed" &&
              failure.code.startsWith("responses_incomplete_")
            ? "incomplete"
            : null;

      assert.deepEqual(
        {
          stableEvents: events.map((event) => event.type),
          partialOutput: events
            .filter((event) => event.type === "output.delta")
            .map((event) => event.delta)
            .join(""),
          completedHistory: decoder.completedHistoryItems,
          terminal: failure?.type ?? null,
          usage:
            usage?.type === "usage"
              ? {
                  inputTokens: usage.inputTokens,
                  cachedInputTokens: usage.cachedInputTokens ?? 0,
                  outputTokens: usage.outputTokens,
                  totalTokens: usage.totalTokens,
                }
              : null,
          errorCategory,
          retryable: failure?.type === "failed" ? failure.retryable : null,
          responseId: decoder.completedResponseId,
        },
        fixtureCase.expected,
        fixtureCase.name,
      );
    }
  });
}

test(`${terminalWithoutCreatedFixture.caseId}: present terminal fields remain strict`, () => {
  for (const fixtureCase of terminalWithoutCreatedFixture.cases) {
    const decoder = new ResponsesProtocolDecoder({
      sequencePolicy: "required",
      completedCheckpoint: () => null,
    });
    assert.throws(
      () =>
        decoder.accept({
          ...fixtureCase.terminal,
          response: {
            ...(fixtureCase.terminal.response as Readonly<
              Record<string, unknown>
            >),
            status: "completed",
          },
        }),
      (error: unknown) =>
        error instanceof ModelTransportError &&
        error.code === "responses_status_invalid",
      fixtureCase.name,
    );

    const invalidIdDecoder = new ResponsesProtocolDecoder({
      sequencePolicy: "required",
      completedCheckpoint: () => null,
    });
    assert.throws(
      () =>
        invalidIdDecoder.accept({
          ...fixtureCase.terminal,
          response: {
            ...(fixtureCase.terminal.response as Readonly<
              Record<string, unknown>
            >),
            id: "",
          },
        }),
      (error: unknown) =>
        error instanceof ModelTransportError &&
        error.code === "responses_response_id_invalid",
      fixtureCase.name,
    );

    const mismatchDecoder = new ResponsesProtocolDecoder({
      sequencePolicy: "required",
      completedCheckpoint: () => null,
    });
    mismatchDecoder.accept({
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp-created" },
    });
    assert.throws(
      () =>
        mismatchDecoder.accept({
          ...fixtureCase.terminal,
          sequence_number: 1,
          response: {
            ...(fixtureCase.terminal.response as Readonly<
              Record<string, unknown>
            >),
            id: "resp-other",
          },
        }),
      (error: unknown) =>
        error instanceof ModelTransportError &&
        error.code === "responses_response_id_mismatch",
      fixtureCase.name,
    );
  }
});

test("response.completed still requires its status field", () => {
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    completedCheckpoint: () => null,
  });
  decoder.accept({
    type: "response.created",
    sequence_number: 0,
    response: { id: "resp-completed-status" },
  });
  assert.throws(
    () =>
      decoder.accept({
        type: "response.completed",
        sequence_number: 1,
        response: { id: "resp-completed-status" },
      }),
    (error: unknown) =>
      error instanceof ModelTransportError &&
      error.code === "responses_status_invalid",
  );
});

for (const sequencePolicy of ["required", "whenPresent"] as const) {
  test(`${createdWithoutIdFixture.caseId}: ${sequencePolicy} transport framing`, () => {
    for (const fixtureCase of createdWithoutIdFixture.cases) {
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy,
        completedCheckpoint: () => null,
      });
      const events = fixtureCase.events.flatMap((event) =>
        decoder.accept(event),
      );
      decoder.finish();
      const failure = events.find((event) => event.type === "failed");
      const completed = events.find((event) => event.type === "completed");

      assert.deepEqual(
        {
          stableEvents: events.map((event) => event.type),
          terminal: failure?.type ?? completed?.type ?? null,
          errorCategory:
            failure?.type === "failed" &&
            failure.code.startsWith("responses_provider_")
              ? "provider"
              : failure?.type === "failed" &&
                  failure.code.startsWith("responses_incomplete_")
                ? "incomplete"
                : null,
          retryable: failure?.type === "failed" ? failure.retryable : null,
          responseId: decoder.completedResponseId,
        },
        fixtureCase.expected,
        fixtureCase.name,
      );
    }
  });
}

test(`${createdWithoutIdFixture.caseId}: late identity drives only the completion checkpoint`, () => {
  const fixtureCase = createdWithoutIdFixture.cases.find(
    (candidate) => candidate.name === "completed",
  );
  assert.ok(fixtureCase !== undefined);
  const createdResponseIds: string[] = [];
  const completedResponseIds: string[] = [];
  const completedCheckpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0" as const,
    adapterName: "direct-responses",
    adapterVersion: "2",
    modelId: "provider-model",
    opaquePayload: { responseId: "resp-late-identity" },
  };
  const decoder = new ResponsesProtocolDecoder({
    sequencePolicy: "required",
    createdCheckpoint: (responseId) => {
      createdResponseIds.push(responseId);
      return null;
    },
    completedCheckpoint: (responseId) => {
      completedResponseIds.push(responseId);
      return completedCheckpoint;
    },
  });

  const events = fixtureCase.events.flatMap((event) => decoder.accept(event));
  decoder.finish();

  assert.deepEqual(createdResponseIds, []);
  assert.deepEqual(completedResponseIds, ["resp-late-identity"]);
  assert.deepEqual(
    events.find((event) => event.type === "completed"),
    { type: "completed", checkpoint: completedCheckpoint },
  );
});

test(`${createdWithoutIdFixture.caseId}: present identity and terminal fields remain strict`, () => {
  const acceptCreated = (response: Readonly<Record<string, unknown>>) => {
    const decoder = new ResponsesProtocolDecoder({
      sequencePolicy: "required",
      completedCheckpoint: () => null,
    });
    decoder.accept({
      type: "response.created",
      sequence_number: 0,
      response,
    });
    return decoder;
  };

  assert.throws(
    () => acceptCreated({ id: "" }),
    (error: unknown) =>
      error instanceof ModelTransportError &&
      error.code === "responses_response_id_invalid",
  );

  const duplicate = acceptCreated({});
  assert.throws(
    () =>
      duplicate.accept({
        type: "response.created",
        sequence_number: 1,
        response: {},
      }),
    (error: unknown) =>
      error instanceof ModelTransportError &&
      error.code === "responses_created_duplicate",
  );

  for (const response of [
    { id: "", status: "completed" },
    { id: "resp-late", status: "failed" },
  ]) {
    const decoder = acceptCreated({});
    assert.throws(
      () =>
        decoder.accept({
          type: "response.completed",
          sequence_number: 1,
          response,
        }),
      (error: unknown) =>
        error instanceof ModelTransportError &&
        ["responses_response_id_invalid", "responses_status_invalid"].includes(
          error.code,
        ),
    );
  }

  const mismatch = acceptCreated({ id: "resp-created" });
  assert.throws(
    () =>
      mismatch.accept({
        type: "response.completed",
        sequence_number: 1,
        response: { id: "resp-other", status: "completed" },
      }),
    (error: unknown) =>
      error instanceof ModelTransportError &&
      error.code === "responses_response_id_mismatch",
  );
});
