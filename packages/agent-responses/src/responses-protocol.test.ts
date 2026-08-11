import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
          completionEvents: events.filter(
            (event) => event.type === "completed",
          ).length,
          errorCategory: null,
          retryable: null,
        },
        fixture.expected,
        fixtureCase.name,
      );
    }
  });
}
