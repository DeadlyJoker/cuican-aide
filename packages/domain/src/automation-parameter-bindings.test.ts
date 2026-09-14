import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAutomationParameterBindings,
  resolveAutomationParameters,
} from "./automation-parameter-bindings.ts";

test("F04-R02/R07 dates derive from the occurrence in the schedule timezone", () => {
  const input = { literal: "unchanged", date: "old", start: "old", end: "old" };
  const bindings = {
    date: "runDate",
    start: "previousWeekStart",
    end: "previousWeekEnd",
  } as const;
  assert.deepEqual(
    resolveAutomationParameters(
      input,
      bindings,
      "2026-09-13T17:00:00.000Z",
      "Asia/Shanghai",
    ),
    {
      literal: "unchanged",
      date: "2026-09-14",
      start: "2026-09-07",
      end: "2026-09-13",
    },
  );
  assert.equal(input.date, "old");
  assert.deepEqual(
    resolveAutomationParameters(
      input,
      bindings,
      "2026-09-13T17:00:00.000Z",
      "America/Los_Angeles",
    ),
    {
      literal: "unchanged",
      date: "2026-09-13",
      start: "2026-08-31",
      end: "2026-09-06",
    },
  );
});

test("F04-R05/R07 DST and delayed retries use the frozen occurrence, not now", () => {
  const bindings = {
    date: "runDate",
    start: "previousWeekStart",
    end: "previousWeekEnd",
  } as const;
  for (const occurrence of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
    assert.deepEqual(
      resolveAutomationParameters({}, bindings, occurrence, "America/New_York"),
      {
        date: "2026-11-01",
        start: "2026-10-19",
        end: "2026-10-25",
      },
    );
  }
  assert.deepEqual(
    resolveAutomationParameters({}, bindings, "2027-01-04T00:00:00Z", "UTC"),
    {
      date: "2027-01-04",
      start: "2026-12-28",
      end: "2027-01-03",
    },
  );
});

test("F04-R02/R09 rejects expression engines, unsafe names, invalid timezone and timestamp", () => {
  for (const invalid of [
    { date: "now()" },
    { constructor: "runDate" },
    [],
    null,
    Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`p${i}`, "runDate"]),
    ),
  ]) {
    assert.throws(() => parseAutomationParameterBindings(invalid));
  }
  assert.throws(() => resolveAutomationParameters({}, {}, "not-a-date", "UTC"));
  assert.throws(() =>
    resolveAutomationParameters({}, {}, "2026-02-30T00:00:00Z", "UTC"),
  );
  assert.throws(() =>
    resolveAutomationParameters({}, {}, "2026-09-14T00:00:00Z", "invalid/zone"),
  );
});
